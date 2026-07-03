import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockServer {
  baseUrl: string;
  close(): Promise<void>;
  /** Requests received, in order. */
  requests: Array<{ path: string; body: unknown; headers: Record<string, string | string[] | undefined> }>;
}

export type MockBehavior =
  | { kind: 'sse'; chunks: string[]; delayMs?: number; omitDone?: boolean }
  | { kind: 'json'; status: number; body: unknown }
  | { kind: 'hang-after-first-chunk'; firstChunk: string };

/** Minimal OpenAI-compatible fake for offline, deterministic tests. */
export async function startMockServer(behavior: MockBehavior): Promise<MockServer> {
  const requests: MockServer['requests'] = [];

  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      requests.push({
        path: req.url ?? '',
        body: raw ? JSON.parse(raw) : undefined,
        headers: req.headers,
      });

      if (behavior.kind === 'json') {
        res.writeHead(behavior.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(behavior.body));
        return;
      }

      res.writeHead(200, { 'content-type': 'text/event-stream' });

      if (behavior.kind === 'hang-after-first-chunk') {
        res.write(sseChunk(behavior.firstChunk));
        return; // never ends — used to test cancellation
      }

      const writeAll = async () => {
        for (const text of behavior.chunks) {
          res.write(sseChunk(text));
          if (behavior.delayMs) await new Promise((r) => setTimeout(r, behavior.delayMs));
        }
        if (!behavior.omitDone) res.write('data: [DONE]\n\n');
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
