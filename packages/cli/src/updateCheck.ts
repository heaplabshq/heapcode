export interface UpdateCheckResult {
  current: string;
  latest: string;
}

/**
 * Best-effort, fire-and-forget check against npm's own registry for a newer
 * published version of this package — never phones anything else, never
 * blocks the caller for long (a short timeout), and never throws: any
 * failure (offline, registry down, unpublished package) just resolves to
 * undefined, same as "no update available".
 */
export async function checkForUpdate(
  packageName: string,
  currentVersion: string,
  timeoutMs = 1_500,
): Promise<UpdateCheckResult | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // The abbreviated `/latest` document (not the full packument) is exactly
    // the one field this needs — smallest payload the registry offers.
    const res = await fetch(`https://registry.npmjs.org/${packageName}/latest`, { signal: controller.signal });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { version?: string };
    const latest = data.version;
    if (!latest || !isNewer(latest, currentVersion)) return undefined;
    return { current: currentVersion, latest };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** Plain numeric `major.minor.patch` comparison — this project has never used prerelease/build tags. */
function isNewer(latest: string, current: string): boolean {
  const a = latest.split('.').map(Number);
  const b = current.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}
