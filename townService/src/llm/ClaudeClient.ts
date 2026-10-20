import axios from 'axios';
import { Readable } from 'stream';

export const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
export const CLAUDE_MODEL = 'claude-haiku-5-5';
const ANTHROPIC_VERSION = '2023-06-01';
// Thinking tokens count toward this limit too, so it is set well above the length of an NPC reply
const MAX_TOKENS = 2048;
// Story 2: fall back if the LLM stops responding for longer than 5 seconds
export const DEFAULT_TIMEOUT_MS = 5000;

export type ChatMessage = {
  role: 'user' | 'assistant';
  content: string;
};

export type StreamReplyOptions = {
  /** Aborting this signal cancels the request to Claude (e.g. when the player disconnects) */
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type StreamReply = (
  system: string,
  messages: ChatMessage[],
  options?: StreamReplyOptions,
) => AsyncGenerator<string>;

/** Thrown when Claude cannot be reached, rejects the request, or stops responding in time */
export class ClaudeError extends Error {
  readonly timedOut: boolean;

  readonly status?: number;

  constructor(
    message: string,
    { timedOut = false, status }: { timedOut?: boolean; status?: number } = {},
  ) {
    super(message);
    this.name = 'ClaudeError';
    this.timedOut = timedOut;
    this.status = status;
  }
}

// @types/node 18.6 omits AbortSignal's EventTarget methods, which Node 16+ provides at runtime
type ListenableSignal = AbortSignal & {
  addEventListener(type: 'abort', listener: () => void): void;
  removeEventListener(type: 'abort', listener: () => void): void;
};

type StreamEvent = { type: string; text?: string; error?: string };

/**
 * Parses one server-sent event from Claude's stream (the text between blank lines), returning
 * the reply text it carries, 'stop' at the end of the message, an error, or undefined for
 * events with no reply text (message_start, pings, thinking, ...).
 */
export function parseStreamEvent(rawEvent: string): StreamEvent | undefined {
  const dataLine = rawEvent.split('\n').find(line => line.startsWith('data:'));
  if (!dataLine) {
    return undefined;
  }
  let data;
  try {
    data = JSON.parse(dataLine.slice('data:'.length));
  } catch {
    return undefined;
  }
  if (data?.type === 'content_block_delta' && data.delta?.type === 'text_delta') {
    return { type: 'text', text: data.delta.text };
  }
  if (data?.type === 'message_stop') {
    return { type: 'stop' };
  }
  if (data?.type === 'error') {
    return { type: 'error', error: data.error?.message ?? 'unknown error' };
  }
  return undefined;
}

/**
 * Sends the conversation to Claude Haiku over the Messages API and yields the reply text as it
 * streams in. Uses axios rather than the Anthropic SDK because the SDK requires Node 20+ and
 * does not run on Node 16 (CI).
 */
export async function* streamClaudeReply(
  system: string,
  messages: ChatMessage[],
  { signal, timeoutMs = DEFAULT_TIMEOUT_MS }: StreamReplyOptions = {},
): AsyncGenerator<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new ClaudeError('ANTHROPIC_API_KEY is not set');
  }

  const controller = new AbortController();
  const callerSignal = signal as ListenableSignal | undefined;
  let stream: Readable | undefined;
  const onCallerAbort = () => {
    controller.abort();
    stream?.destroy();
  };
  callerSignal?.addEventListener('abort', onCallerAbort);

  // Restarted on every chunk, so it fires if Claude goes silent for timeoutMs at any point
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  const resetTimer = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      stream?.destroy();
    }, timeoutMs);
  };

  resetTimer();
  try {
    try {
      const response = await axios.post<Readable>(
        CLAUDE_API_URL,
        {
          model: CLAUDE_MODEL,
          max_tokens: MAX_TOKENS,
          system,
          messages,
          stream: true,
          // Low effort keeps thinking short so replies start quickly
          output_config: { effort: 'low' },
        },
        {
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
            'content-type': 'application/json',
          },
          responseType: 'stream',
          signal: controller.signal,
        },
      );
      stream = response.data;
    } catch (err) {
      if (timedOut) {
        throw new ClaudeError(`Claude did not respond within ${timeoutMs}ms`, { timedOut: true });
      }
      if (axios.isAxiosError(err) && err.response) {
        throw new ClaudeError(`Claude responded with status ${err.response.status}`, {
          status: err.response.status,
        });
      }
      throw new ClaudeError(`Could not reach Claude: ${(err as Error).message}`);
    }

    // Decode as UTF-8 at the stream level so characters split across chunks stay intact
    stream.setEncoding('utf8');
    let buffered = '';
    try {
      for await (const chunk of stream) {
        resetTimer();
        buffered += chunk;
        const rawEvents = buffered.split('\n\n');
        buffered = rawEvents.pop() ?? '';
        for (const rawEvent of rawEvents) {
          const event = parseStreamEvent(rawEvent);
          if (event?.type === 'text' && event.text) {
            yield event.text;
          } else if (event?.type === 'stop') {
            return;
          } else if (event?.type === 'error') {
            throw new ClaudeError(`Claude stream error: ${event.error}`);
          }
        }
      }
    } catch (err) {
      if (timedOut) {
        throw new ClaudeError(`Claude stopped responding for ${timeoutMs}ms`, { timedOut: true });
      }
      throw err;
    }
    if (timedOut) {
      throw new ClaudeError(`Claude stopped responding for ${timeoutMs}ms`, { timedOut: true });
    }
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', onCallerAbort);
    // Releases the connection to Claude if the caller stopped reading early
    controller.abort();
  }
}
