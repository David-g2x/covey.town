import Express from 'express';
import { ChatMessage, ClaudeError, StreamReply, streamClaudeReply } from './ClaudeClient';

export const MAX_MESSAGES = 20;
export const MAX_MESSAGE_LENGTH = 2000;
export const FALLBACK_MESSAGE = 'I lost my train of thought! Ask me again in a moment.';

// Placeholder until the dynamic prompt engine (Task 2.2) builds this from the town's NPC config
const BASE_SYSTEM_PROMPT =
  'You are a friendly NPC in Covey.Town, a virtual 2D meeting space. Keep replies short and helpful.';

/**
 * Validates the conversation sent by the client, returning the messages or an error message.
 * Clients may only send user and assistant turns: the system prompt is always set by the server,
 * so players cannot override the NPC's instructions.
 */
export function parseMessages(body: unknown): ChatMessage[] | string {
  const messages = (body as { messages?: unknown } | undefined)?.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return 'messages must be a non-empty array';
  }
  if (messages.length > MAX_MESSAGES) {
    return `messages may contain at most ${MAX_MESSAGES} entries`;
  }
  for (const message of messages) {
    if (message?.role !== 'user' && message?.role !== 'assistant') {
      return 'each message role must be "user" or "assistant"';
    }
    if (typeof message.content !== 'string' || message.content.trim().length === 0) {
      return 'each message content must be a non-empty string';
    }
    if (message.content.length > MAX_MESSAGE_LENGTH) {
      return `each message content may be at most ${MAX_MESSAGE_LENGTH} characters`;
    }
  }
  if (messages[0].role !== 'user' || messages[messages.length - 1].role !== 'user') {
    return 'the first and last messages must be from the user';
  }
  return messages.map(({ role, content }) => ({ role, content }));
}

function sendEvent(res: Express.Response, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Routes for talking to the NPC's LLM, independent of any frontend.
 *
 * POST /stream  body: { messages: [{ role: 'user' | 'assistant', content: string }] }
 * Responds with a text/event-stream of `token` events ({ token }), ending with either a `done`
 * event or an `error` event ({ message }) carrying a fallback message to show the player.
 */
export default function createLLMRouter(
  streamReply: StreamReply = streamClaudeReply,
): Express.Router {
  const router = Express.Router();

  router.post('/stream', async (req, res) => {
    const messages = parseMessages(req.body);
    if (typeof messages === 'string') {
      res.status(400).json({ message: messages });
      return;
    }

    res.status(200).set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // stops nginx on the deployed instance from buffering the stream
    });
    res.flushHeaders();

    // Stop paying for tokens nobody will read if the client disconnects mid-reply
    const abortController = new AbortController();
    res.on('close', () => abortController.abort());

    try {
      for await (const token of streamReply(BASE_SYSTEM_PROMPT, messages, {
        signal: abortController.signal,
      })) {
        sendEvent(res, 'token', { token });
      }
      sendEvent(res, 'done', {});
    } catch (err) {
      if (!abortController.signal.aborted) {
        // eslint-disable-next-line no-console
        console.error('LLM stream failed:', (err as Error).message);
        sendEvent(res, 'error', {
          message: FALLBACK_MESSAGE,
          timedOut: err instanceof ClaudeError && err.timedOut,
        });
      }
    } finally {
      res.end();
    }
  });

  return router;
}
