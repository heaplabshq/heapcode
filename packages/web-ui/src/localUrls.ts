/**
 * Local dev-server addresses in a block of command output — "Local:
 * http://localhost:5173/" from vite, "started server on 0.0.0.0:3000" and the
 * like. The desktop app scans its shells the same way (desktop/src/terminal.cjs).
 */
const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d{2,5}(?:\/[^\s'"\x1b)]*)?/g;
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

export function localUrlsIn(output: string): string[] {
  const found = output.replace(ANSI, '').match(LOCAL_URL) ?? [];
  return [...new Set(found.map((u) => u.replace('0.0.0.0', 'localhost').replace(/[.,;:]+$/, '')))];
}
