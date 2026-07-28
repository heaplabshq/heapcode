import { spawn } from 'node:child_process';
import { findBestMatch } from '../edit/fuzzyMatch.js';
import { safeFetch } from '../net/safeFetch.js';

/**
 * The host-independent half of the agent's workspace tools: limits, the tool
 * schemas both hosts offer, and the pure helpers around matching, fetching,
 * install-command inspection and process killing.
 *
 * What is NOT here is the executor itself. Reading, writing, searching and
 * running commands differ per host all the way down — Node's fs and fast-glob
 * against `vscode.workspace.fs` and `findFiles`, a hidden child process
 * against real terminal shell integration — and so do the tools built on top
 * of each (the extension's language-server tools have no CLI equivalent).
 * Forcing those together would be a worse abstraction than two executors that
 * happen to share this layer.
 */

export const MAX_READ_CHARS = 50_000;
// Above this, an unranged read_file returns an outline instead of the full text —
// SWE-agent's ACI work found this kind of windowed view (vs. dumping whole files)
// meaningfully improves an agent's ability to navigate large codebases cheaply.
export const LARGE_FILE_LINES = 300;
export const MAX_OUTPUT_CHARS = 8_000;
export const MAX_SEARCH_RESULTS = 40;
export const MAX_SEARCH_FILES = 2_000;
export const MAX_FETCH_CHARS = 20_000;
// A fast-apply model must re-emit the whole file — same ceiling inline-edit's own apply
// action uses, past which the round-trip cost outweighs skipping the merge and just failing.
export const MAX_APPLY_MERGE_CHARS = 40_000;
export const CWD_MARKER = '__HEAPCODE_CWD__';

// write_file does a blind full-file overwrite — fine for a new file, but a
// real incident had a sub-agent "fixing" an unrelated file rewrite
// package.json via write_file and silently drop its "name" field.
// edit_file/multi_edit's targeted search/replace can't lose content this way,
// so overwriting one of these wholesale is refused in favor of that — only
// when the file already exists; writing a brand new one is unaffected.
export const PROTECTED_MANIFEST_FILES = new Set([
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'Cargo.toml',
  'Cargo.lock',
  'go.mod',
  'go.sum',
  'requirements.txt',
  'Pipfile',
  'Pipfile.lock',
  'Gemfile',
  'Gemfile.lock',
  'composer.json',
  'composer.lock',
  'tsconfig.json',
  'pyproject.toml',
]);

export function truncate(content: string): string {
  if (content.length <= MAX_OUTPUT_CHARS) return content;
  return content.slice(0, MAX_OUTPUT_CHARS / 2) + '\n…[output truncated]…\n' + content.slice(-MAX_OUTPUT_CHARS / 2);
}

/**
 * Points the model at the closest thing to its failed `search` text, so the
 * retry has something concrete to copy from instead of guessing again.
 */
export function nearbyHint(content: string, search: string): string {
  const anchor = search.split('\n').find((l) => l.trim().length > 8);
  if (!anchor) return '';
  const match = findBestMatch(content, anchor.trim());
  if (!match) return '';
  const lines = content.split('\n');
  let offset = 0;
  let matchLine = 0;
  for (let i = 0; i < lines.length; i++) {
    offset += lines[i]!.length + 1;
    if (offset > match.start) {
      matchLine = i;
      break;
    }
  }
  const start = Math.max(0, matchLine - 6);
  const end = Math.min(lines.length, matchLine + 7);
  const snippet = lines
    .slice(start, end)
    .map((l, i) => `${start + i + 1}\t${l}`)
    .join('\n');
  return `The closest matching region is:\n${snippet}\n`;
}

/**
 * The "update" fed to the fast-apply model when edit_file's exact match fails —
 * gives it both what should disappear and what should appear, since the search
 * text alone drifting slightly from the file is exactly why the deterministic
 * match missed in the first place.
 */
export function buildEditSnippet(search: string, replace: string): string {
  return `Replace this code:\n${search}\n\nwith this code:\n${replace}`;
}

/**
 * Kill a spawned command *and everything it started*.
 *
 * `child.kill()` alone only signals the wrapper shell. Because run_command
 * wraps the user's command in a multi-statement script (the CWD_MARKER echo),
 * the shell can't exec-optimize it away and instead forks the real program as
 * a grandchild — which survives the shell's death, reparented to init. That
 * made both the timeout and the user's Stop a lie: the message said "killed"
 * while a dev server kept holding its port. Worse, the orphan inherits the
 * stdout pipe, so 'close' doesn't fire until it exits on its own — a timed-out
 * long-running process blocked the agent for its entire lifetime, not for the
 * timeout.
 *
 * POSIX: spawning detached puts the shell in its own process group whose id
 * equals its pid, so a negative pid signals the whole group. Windows has no
 * process groups to signal this way — taskkill /T walks the child tree
 * instead, with child.kill() as the last resort if it isn't available.
 */
export function killTree(child: ReturnType<typeof spawn>): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F']).on('error', () => child.kill('SIGKILL'));
    } catch {
      child.kill('SIGKILL');
    }
    return;
  }
  try {
    // Negative pid = "every process in this group". ESRCH here just means the
    // group already exited between the timer firing and this call.
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

/** Fetch a URL; HTML is reduced to readable text. Throws with a useful message. */
export async function fetchUrl(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    // safeFetch (not fetch) — blocks private/loopback/link-local targets on the
    // initial URL and on every redirect hop. See core's safeFetch for why.
    const res = await safeFetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'HeapCode-Agent', accept: 'text/html, text/plain, application/json, */*' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
    const type = res.headers.get('content-type') ?? '';
    let body = await res.text();
    if (type.includes('html')) body = htmlToText(body);
    if (body.length > MAX_FETCH_CHARS) body = body.slice(0, MAX_FETCH_CHARS) + '\n…[truncated]';
    return body.trim() || '(empty response)';
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw new Error(`Timed out fetching ${url}`);
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    clearTimeout(timeout);
  }
}

/** Install-command shapes we recognize per package registry (order doesn't matter — first match wins). */
const INSTALL_PATTERNS: Array<{ re: RegExp; registry: 'npm' | 'pypi' }> = [
  { re: /^(?:npm|pnpm)\s+(?:install|i|add)\b/, registry: 'npm' },
  { re: /^yarn\s+add\b/, registry: 'npm' },
  { re: /^(?:pip3?|python3?\s+-m\s+pip)\s+install\b/, registry: 'pypi' },
  { re: /^poetry\s+add\b/, registry: 'pypi' },
];

/**
 * Extract package names from an install-shaped command, for the
 * hallucinated-package guard. Returns undefined when the command isn't an
 * install, installs from a file/lockfile (no new name being introduced), or
 * only references local paths/VCS URLs.
 */
export function detectPackageInstall(command: string): { registry: 'npm' | 'pypi'; names: string[] } | undefined {
  const trimmed = command.trim();
  const matched = INSTALL_PATTERNS.find((p) => p.re.test(trimmed));
  if (!matched) return undefined;
  const rest = trimmed.replace(matched.re, '').trim();
  const tokens = rest.split(/\s+/).filter(Boolean);
  const names: string[] = [];
  for (const t of tokens) {
    if (t.startsWith('-')) {
      // Installing from a requirements file/editable local path — not a named package to verify.
      if (['-r', '--requirement', '-e', '--editable'].includes(t)) return undefined;
      continue;
    }
    if (t === '.' || t.startsWith('./') || t.startsWith('../') || t.startsWith('/') || t.includes('://')) {
      continue; // local path or VCS/tarball URL — not a registry lookup
    }
    const name = matched.registry === 'npm' ? t.replace(/^(@?[^@]+).*$/, '$1') : t.split(/[=<>!~[]/)[0]!;
    if (name) names.push(name);
  }
  return names.length > 0 ? { registry: matched.registry, names } : undefined;
}

/** Best-effort registry lookup; network failures resolve to "exists" (fail open, never block on our own flakiness). */
export async function checkPackageExists(registry: 'npm' | 'pypi', name: string): Promise<boolean> {
  if (!name) return true;
  const url =
    registry === 'pypi'
      ? `https://pypi.org/pypi/${encodeURIComponent(name)}/json`
      : `https://registry.npmjs.org/${name.startsWith('@') ? name.replace('/', '%2f') : encodeURIComponent(name)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return res.ok;
  } catch {
    return true;
  } finally {
    clearTimeout(timeout);
  }
}

/** Crude but dependency-free HTML → text: drop script/style, strip tags, decode entities. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n');
}
