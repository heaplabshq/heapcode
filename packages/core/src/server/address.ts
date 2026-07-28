import { createHash } from 'node:crypto';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { PROTOCOL_VERSION } from './protocol.js';

/**
 * Where the daemon listens, and where its per-launch token lives.
 *
 * The address embeds the protocol major version, so a client built against
 * an older protocol simply finds nothing at its address and starts its own
 * server rather than talking nonsense to a newer one
 * (docs/phase3-protocol-design.md §6).
 *
 * NOTE: `heapcodeHome()` deliberately mirrors packages/cli/src/paths.ts:31-33
 * rather than importing it — core cannot depend on cli. Both read the same
 * env var with the same fallback, which is what makes them agree; if one
 * changes, the other must.
 */
export function heapcodeHome(): string {
  return process.env.HEAPCODE_HOME || join(homedir(), '.heapcode');
}

/**
 * A unix socket path on macOS/Linux, a named pipe on Windows.
 *
 * Windows pipe names live in a machine-global namespace, so the name carries
 * a hash of the user identity — without it, two users on one machine would
 * collide on the same pipe (§1, §3).
 */
export function daemonAddress(home: string = heapcodeHome()): string {
  if (process.platform === 'win32') {
    const who = safeUsername();
    const tag = createHash('sha256').update(`${who}:${home}`).digest('hex').slice(0, 16);
    return `\\\\.\\pipe\\heapcode-${PROTOCOL_VERSION}-${tag}`;
  }
  return join(home, `daemon-${PROTOCOL_VERSION}.sock`);
}

export function daemonTokenFile(home: string = heapcodeHome()): string {
  return join(home, `daemon-${PROTOCOL_VERSION}.token`);
}

export function daemonLogFile(home: string = heapcodeHome()): string {
  return join(home, `daemon-${PROTOCOL_VERSION}.log`);
}

/**
 * The kernel's cap on a unix socket path (`sun_path`): 104 bytes on
 * macOS/BSD, 108 on Linux. Exceeding it fails `listen` with a bare EINVAL
 * that says nothing about length, so callers check up front and say
 * something useful instead.
 */
export const MAX_UNIX_SOCKET_PATH_BYTES = 104;

/** An actionable error when `address` can't be bound, or undefined when it's fine. */
export function socketAddressProblem(address: string): string | undefined {
  if (!addressIsFile(address)) return undefined;
  const bytes = Buffer.byteLength(address);
  if (bytes <= MAX_UNIX_SOCKET_PATH_BYTES) return undefined;
  return (
    `The socket path is ${bytes} bytes, over this platform's ${MAX_UNIX_SOCKET_PATH_BYTES}-byte limit: ${address}. ` +
    'Set HEAPCODE_HOME to a shorter directory.'
  );
}

/** A socket path is a filesystem path only off Windows; named pipes are not unlinkable. */
export function addressIsFile(address: string): boolean {
  return process.platform !== 'win32' && !address.startsWith('\\\\');
}

function safeUsername(): string {
  try {
    return userInfo().username;
  } catch {
    return 'unknown';
  }
}
