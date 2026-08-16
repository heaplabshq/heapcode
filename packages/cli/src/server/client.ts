import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  connectToServer as coreConnectToServer,
  type ConnectOptions as CoreConnectOptions,
  type HelloParams,
  type ServerConnection,
} from '@heapcode/core';
import { globalDir } from '@heapcode/host';

export type { ServerConnection } from '@heapcode/core';

/** The CLI's own knobs; `daemonEntry` is filled in below, so callers never pass it. */
export type ConnectOptions = Omit<CoreConnectOptions, 'daemonEntry'>;

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * The CLI's binding of the shared client (packages/core/src/server/client.ts).
 *
 * Only two things are host-specific and neither belongs in core: where this
 * host's per-user state lives (`globalDir()`), and where its bundled daemon
 * entry point sits (dist/daemon.js, next to dist/cli.js). Everything else —
 * the connect/spawn/poll sequence, the token handshake, the framing — is the
 * one implementation all three clients share.
 */
export function connectToServer(
  hello: Omit<HelloParams, 'token' | 'protocolVersion'>,
  opts: ConnectOptions = {},
): Promise<ServerConnection> {
  return coreConnectToServer(hello, {
    ...opts,
    home: opts.home ?? globalDir(),
    daemonEntry: join(__dirname, 'daemon.js'),
  });
}
