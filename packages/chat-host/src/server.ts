import { startWebHost, type RunningWebHost, type WebHostOptions } from '@heapcode/web-host';
import { ChatSession, type ChatSessionDeps } from './session.js';

export type ChatHostOptions = Omit<WebHostOptions, 'createSession'> & {
  /** Where personal memory lives; defaults to the global store. See ChatSessionDeps. */
  memoryFile?: string;
};

/**
 * Serve Heap Chat.
 *
 * The HTTP/WebSocket shell, the token exchange, the origin allowlist and the
 * failed-attempt limiter are `@heapcode/web-host`'s and are used unchanged —
 * none of that is product-specific, and a second copy of the DNS-rebinding
 * defense in particular is exactly the kind of duplication that gets fixed on
 * one side only. What differs is the session, which is injected: a
 * `ChatSession` with its own tool roster, its own system prompt and no
 * workspace panel.
 */
export async function startChatHost(opts: ChatHostOptions): Promise<RunningWebHost> {
  return startWebHost({
    ...opts,
    createSession: (deps) =>
      new ChatSession({
        root: deps.root,
        config: deps.config,
        secrets: deps.secrets,
        connect: deps.connect,
        clientVersion: deps.clientVersion,
        mcpLogins: deps.mcpLogins,
        workspaces: deps.workspaces,
        lan: deps.lan,
        nativeToolCalls: deps.nativeToolCalls,
        memoryFile: opts.memoryFile,
      } satisfies ChatSessionDeps),
  });
}
