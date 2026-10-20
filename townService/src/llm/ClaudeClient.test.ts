import axios from 'axios';
import { PassThrough, Readable } from 'stream';
import {
  CLAUDE_API_URL,
  CLAUDE_MODEL,
  ClaudeError,
  parseStreamEvent,
  streamClaudeReply,
} from './ClaudeClient';

const SYSTEM = 'You are a test NPC.';
const MESSAGES = [{ role: 'user' as const, content: 'hi' }];

function textEvent(text: string): string {
  return `event: content_block_delta\ndata: ${JSON.stringify({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text },
  })}\n\n`;
}

const MESSAGE_START = `event: message_start\ndata: ${JSON.stringify({
  type: 'message_start',
})}\n\n`;
const MESSAGE_STOP = `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`;

async function collect(generator: AsyncGenerator<string>): Promise<string[]> {
  const tokens: string[] = [];
  for await (const token of generator) {
    tokens.push(token);
  }
  return tokens;
}

describe('parseStreamEvent', () => {
  it('extracts reply text from text deltas', () => {
    expect(parseStreamEvent(textEvent('hello'))).toEqual({ type: 'text', text: 'hello' });
  });
  it('recognizes the end of the message', () => {
    expect(parseStreamEvent(MESSAGE_STOP)).toEqual({ type: 'stop' });
  });
  it('recognizes stream errors', () => {
    const event = `event: error\ndata: ${JSON.stringify({
      type: 'error',
      error: { type: 'overloaded_error', message: 'Overloaded' },
    })}`;
    expect(parseStreamEvent(event)).toEqual({ type: 'error', error: 'Overloaded' });
  });
  it('ignores events without reply text and malformed data', () => {
    expect(parseStreamEvent(MESSAGE_START)).toBeUndefined();
    expect(
      parseStreamEvent(
        `event: content_block_delta\ndata: ${JSON.stringify({
          type: 'content_block_delta',
          delta: { type: 'thinking_delta', thinking: '' },
        })}`,
      ),
    ).toBeUndefined();
    expect(parseStreamEvent('event: ping')).toBeUndefined();
    expect(parseStreamEvent('data: {not json')).toBeUndefined();
  });
});

describe('streamClaudeReply', () => {
  let postSpy: jest.SpyInstance;
  const originalKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    postSpy = jest.spyOn(axios, 'post');
  });
  afterEach(() => {
    postSpy.mockRestore();
    process.env.ANTHROPIC_API_KEY = originalKey;
  });

  it('sends a streaming request for Claude Haiku with the API key', async () => {
    postSpy.mockResolvedValue({ data: Readable.from([MESSAGE_STOP]) });
    await collect(streamClaudeReply(SYSTEM, MESSAGES));

    expect(postSpy).toHaveBeenCalledWith(
      CLAUDE_API_URL,
      expect.objectContaining({
        model: CLAUDE_MODEL,
        system: SYSTEM,
        messages: MESSAGES,
        stream: true,
      }),
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-api-key': 'test-key',
          'anthropic-version': '2023-06-01',
        }),
        responseType: 'stream',
      }),
    );
  });

  it('yields reply text in order, including events split across chunks', async () => {
    const body = `${MESSAGE_START}${textEvent('Hello')}${textEvent(' wor')}${textEvent(
      'ld',
    )}${MESSAGE_STOP}`;
    postSpy.mockResolvedValue({ data: Readable.from([body.slice(0, 70), body.slice(70)]) });
    expect(await collect(streamClaudeReply(SYSTEM, MESSAGES))).toEqual(['Hello', ' wor', 'ld']);
  });

  it('keeps multi-byte characters intact when split across chunks', async () => {
    const bytes = Buffer.from(`${textEvent('café 👋')}${MESSAGE_STOP}`);
    const splitAt = bytes.indexOf(Buffer.from('👋')) + 2;
    postSpy.mockResolvedValue({
      data: Readable.from([bytes.subarray(0, splitAt), bytes.subarray(splitAt)]),
    });
    expect(await collect(streamClaudeReply(SYSTEM, MESSAGES))).toEqual(['café 👋']);
  });

  it('throws without calling Claude when ANTHROPIC_API_KEY is not set', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await expect(collect(streamClaudeReply(SYSTEM, MESSAGES))).rejects.toBeInstanceOf(ClaudeError);
    expect(postSpy).not.toHaveBeenCalled();
  });

  it('throws a ClaudeError with the status when Claude rejects the request', async () => {
    postSpy.mockRejectedValue(
      Object.assign(new Error('Request failed'), { isAxiosError: true, response: { status: 429 } }),
    );
    await expect(collect(streamClaudeReply(SYSTEM, MESSAGES))).rejects.toMatchObject({
      status: 429,
      timedOut: false,
    });
  });

  it('throws a ClaudeError when Claude cannot be reached', async () => {
    postSpy.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(collect(streamClaudeReply(SYSTEM, MESSAGES))).rejects.toBeInstanceOf(ClaudeError);
  });

  it('throws a ClaudeError when the stream reports an error', async () => {
    const errorEvent = `event: error\ndata: ${JSON.stringify({
      type: 'error',
      error: { type: 'overloaded_error', message: 'Overloaded' },
    })}\n\n`;
    postSpy.mockResolvedValue({ data: Readable.from([textEvent('Hi'), errorEvent]) });
    await expect(collect(streamClaudeReply(SYSTEM, MESSAGES))).rejects.toBeInstanceOf(ClaudeError);
  });

  it('times out when Claude does not respond', async () => {
    postSpy.mockImplementation(
      (_url, _body, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(new Error('canceled')));
        }),
    );
    await expect(
      collect(streamClaudeReply(SYSTEM, MESSAGES, { timeoutMs: 50 })),
    ).rejects.toMatchObject({ timedOut: true });
  });

  it('times out when the stream stalls after some text', async () => {
    const stream = new PassThrough();
    stream.write(textEvent('partial'));
    postSpy.mockResolvedValue({ data: stream });
    const tokens: string[] = [];
    const consume = async () => {
      for await (const token of streamClaudeReply(SYSTEM, MESSAGES, { timeoutMs: 50 })) {
        tokens.push(token);
      }
    };
    await expect(consume()).rejects.toMatchObject({ timedOut: true });
    expect(tokens).toEqual(['partial']);
  });

  it('cancels the request to Claude when the caller aborts', async () => {
    let requestSignal: AbortSignal | undefined;
    postSpy.mockImplementation((_url, _body, options) => {
      requestSignal = options.signal;
      return Promise.resolve({ data: new PassThrough() });
    });
    const caller = new AbortController();
    const generator = streamClaudeReply(SYSTEM, MESSAGES, { signal: caller.signal });
    const pending = generator.next().catch(() => undefined);
    await new Promise(resolve => {
      setImmediate(resolve);
    });
    caller.abort();
    await pending;
    expect(requestSignal?.aborted).toBe(true);
  });
});
