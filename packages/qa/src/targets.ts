import { isLocalPage } from '@heapcode/web-host/browserTools';

/**
 * Which addresses Heap QA may drive.
 *
 * Local ones always — the same test as Heap Code's browser tools, so "local"
 * means one thing across the products. Anything else only when the folder's
 * `heapqa.yaml` lists it under `targets`: a tester that fills in forms and
 * clicks Submit has no business on a site nobody named (docs/QA_PLAN.md §8).
 */
export function isAllowedTarget(url: string, targets: readonly string[]): boolean {
  if (isLocalPage(url)) return true;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return targets.some((pattern) => matchesTarget(parsed, pattern));
}

function matchesTarget(url: URL, pattern: string): boolean {
  const m = /^(https?):\/\/(\*\.)?([^/:]+)(?::(\d+))?\/?$/i.exec(pattern.trim());
  if (!m) return false;
  const [, scheme, wildcard, host, port] = m;
  if (url.protocol !== `${scheme!.toLowerCase()}:`) return false;
  if ((url.port || '') !== (port ?? '')) return false;
  const want = host!.toLowerCase();
  const got = url.hostname.toLowerCase();
  // `*.vercel.app` is any subdomain, not vercel.app itself — the bare domain
  // is usually someone else's.
  return wildcard ? got.endsWith(`.${want}`) : got === want;
}

export function notAllowedMessage(url: string): string {
  return (
    `${url} is not a local address and is not listed in heapqa.yaml. ` +
    'To test it, add its origin under `targets:`, e.g.\n  targets:\n    - ' +
    (() => {
      try {
        return new URL(url).origin;
      } catch {
        return 'https://staging.example.com';
      }
    })()
  );
}
