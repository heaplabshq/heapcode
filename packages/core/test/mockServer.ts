import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockServer {
  baseUrl: string;
  close(): Promise<void>;
  /** Requests received, in order. */
  requests: Array<{ path: string; body: unknown; headers: Record<string, string | string[] | undefined> }>;
}

export type MockBehavior =
  | {
      kind: 'sse';
      chunks: string[];
      delayMs?: number;
      omitDone?: boolean;
      /**
       * A final `usage` chunk before [DONE] — the shape OpenAI sends when the
       * request carried `stream_options: {include_usage: true}`: usage at the
       * top level, `choices` empty. Omit for an endpoint that reports nothing.
       */
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    }
  | { kind: 'json'; status: number; body: unknown; headers?: Record<string, string> }
  | { kind: 'hang-after-first-chunk'; firstChunk: string }
  /** Accepts the request and never responds — for timeout tests. */
  | { kind: 'hang' }
  /** Emits the given payloads verbatim as `data:` lines, then [DONE]. */
  | { kind: 'sse-raw'; events: string[] }
  /** Serves responses[i] for the i-th request (last one repeats). */
  | { kind: 'sequence'; responses: Array<Exclude<MockBehavior, { kind: 'sequence' }>> };

/** Minimal OpenAI-compatible fake for offline, deterministic tests. */
export async function startMockServer(behavior: MockBehavior): Promise<MockServer> {
  const requests: MockServer['requests'] = [];
  /** Chat completions served so far — what `sequence` steps through. */
  let chatCalls = 0;

  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      requests.push({
        path: req.url ?? '',
        body: raw ? JSON.parse(raw) : undefined,
        headers: req.headers,
      });

      // `GET /models` gets a stock list ONLY when the scripted behavior is a
      // chat script (`sse`/`sse-raw`/`sequence`), which describes completions
      // and has nothing to say about models. Without this, listing models
      // replied with an SSE chat body and the client died parsing `data: {…}`
      // as JSON. A test that scripts `json` for /models on purpose still gets
      // exactly what it asked for — that is how the listModels tests drive
      // their success and failure cases.
      const chatScript = behavior.kind === 'sse' || behavior.kind === 'sse-raw' || behavior.kind === 'sequence';
      if (chatScript && (req.url ?? '').includes('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'mock-model' }, { id: 'other-model' }] }));
        return;
      }

      let active = behavior;
      if (active.kind === 'sequence') {
        // Counted over chat calls only. Indexing on `requests.length` meant a
        // `/models` fetch consumed a scripted turn, so the agent's first
        // request got the second script.
        const index = Math.min(chatCalls++, active.responses.length - 1);
        active = active.responses[index]!;
      }

      if (active.kind === 'hang') {
        return; // never respond
      }

      if (active.kind === 'json') {
        res.writeHead(active.status, { 'content-type': 'application/json', ...active.headers });
        res.end(JSON.stringify(active.body));
        return;
      }

      res.writeHead(200, { 'content-type': 'text/event-stream' });

      if (active.kind === 'sse-raw') {
        for (const payload of active.events) {
          res.write(`data: ${payload}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      if (active.kind === 'hang-after-first-chunk') {
        res.write(sseChunk(active.firstChunk));
        return; // never ends — used to test cancellation
      }

      const sse = active;
      const writeAll = async () => {
        for (const text of sse.chunks) {
          res.write(sseChunk(text));
          if (sse.delayMs) await new Promise((r) => setTimeout(r, sse.delayMs));
        }
        if (sse.usage) res.write(`data: ${JSON.stringify({ choices: [], usage: sse.usage })}\n\n`);
        if (!sse.omitDone) res.write('data: [DONE]\n\n');
        res.end();
      };
      void writeAll();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function sseChunk(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}
