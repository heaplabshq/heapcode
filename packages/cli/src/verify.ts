import { spawn } from 'node:child_process';

/**
 * `--verify "<command>"` — the project's own checks, run after the agent
 * believes it is done, with the failure fed back so the model fixes its own
 * homework instead of the caller spending a round trip on a lint error.
 *
 * ## Why this file exists at all
 *
 * `--verify` runs a command in a mode where `run_command` may well be denied
 * (`--permission-mode auto-edit` and below deny it outright). That is only
 * defensible under a property this module has to make structurally true, not
 * merely intended:
 *
 *   **the executed command is a fixed argv captured from the CLI invoker at
 *   startup, and nothing the model produces can reach it.**
 *
 * So: parsed ONCE by `parseVerifyCommand` into a frozen string array, spawned
 * with `shell: false` and that same array every cycle, never re-joined,
 * re-parsed, or interpolated with a filename, a tool result, or anything else
 * the model influenced. The model is told what failed; it is never given a
 * way to change what runs. The command is not a tool, is not in the tool list,
 * and appears in the prompt only as text describing a failure.
 *
 * The no-shell rule is what keeps that true rather than merely tidy: through a
 * shell, a `$(...)` or a `&&` in the invoker's own string would be a second
 * command, and "exactly one command" would stop being a property anyone could
 * check. `parseVerifyCommand` therefore rejects shell metacharacters outright
 * instead of passing them through as literal argv — a clear error beats
 * `npm run lint '&&' npm test` failing in a confusing way.
 */

/** Shell operators that only mean something to a shell — and there isn't one. */
const SHELL_OPERATORS = ['&&', '||', ';', '|', '&', '<', '>', '`', '$('];

/** Cap on what is fed back to the model and reported: enough to diagnose, not enough to flood a context window. */
const MAX_OUTPUT_CHARS = 8_000;

/** Hard stop for a check that hangs — without it a wedged test suite wedges the whole run. */
export const VERIFY_TIMEOUT_MS = 10 * 60_000;

export interface VerifyRun {
  /** null when the command could not be spawned at all, or was killed on timeout. */
  exitCode: number | null;
  /** stdout and stderr interleaved, clamped to MAX_OUTPUT_CHARS. */
  output: string;
  /** The command never ran (bad path, not executable) — the invoker's mistake, not something the model can fix. */
  spawnFailed?: boolean;
  timedOut?: boolean;
}

/**
 * Split the invoker's command string into argv, once, at startup.
 *
 * Handles the quoting a person actually types (`--verify "pytest -k 'not
 * slow'"`) and refuses everything that would need a shell. Throws on anything
 * it cannot honour exactly — a `--verify` that silently runs something other
 * than what was written is the one outcome worth failing the whole invocation
 * over.
 */
export function parseVerifyCommand(spec: string): string[] {
  const argv: string[] = [];
  let current = '';
  let started = false;
  let quote: '"' | "'" | undefined;

  for (let i = 0; i < spec.length; i++) {
    const ch = spec[i]!;
    if (quote) {
      if (ch === quote) {
        quote = undefined;
      } else if (quote === '"' && ch === '\\' && i + 1 < spec.length) {
        current += spec[++i];
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (ch === '\\' && i + 1 < spec.length) {
      current += spec[++i];
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) {
        argv.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    // Outside quotes, a shell operator means the caller expects a shell.
    const operator = SHELL_OPERATORS.find((op) => spec.startsWith(op, i));
    if (operator) {
      throw new Error(
        `--verify runs a single command directly, without a shell, so "${operator}" cannot work. ` +
          'Put the chain in a script or a make target and point --verify at that (e.g. --verify "make check").',
      );
    }
    current += ch;
    started = true;
  }

  if (quote) throw new Error(`--verify command has an unbalanced ${quote} quote.`);
  if (started) argv.push(current);
  if (argv.length === 0) throw new Error('--verify needs a command to run, e.g. --verify "make check".');
  return argv;
}

/**
 * Run the captured argv once. `shell: false` is the whole point — see the
 * file header — so `argv[0]` is looked up as a program, never interpreted.
 */
export function runVerifyCommand(
  argv: readonly string[],
  cwd: string,
  timeoutMs: number = VERIFY_TIMEOUT_MS,
): Promise<VerifyRun> {
  return new Promise((resolve) => {
    // Copied, so nothing downstream can observe or mutate the captured array.
    const [command, ...args] = [...argv];
    const child = spawn(command!, args, { cwd, env: process.env, shell: false });
    let output = '';
    let settled = false;
    const append = (chunk: Buffer): void => {
      // Bounded while collecting, not just when reporting: a check that prints
      // a megabyte a second should not be able to exhaust memory here.
      if (output.length < MAX_OUTPUT_CHARS * 4) output += chunk.toString();
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);

    const finish = (run: VerifyRun): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...run, output: clampOutput(run.output) });
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ exitCode: null, output: `${output}\n[verify timed out after ${Math.round(timeoutMs / 1000)}s]`, timedOut: true });
    }, timeoutMs);

    child.on('error', (err) => finish({ exitCode: null, output: `could not run "${command}": ${err.message}`, spawnFailed: true }));
    child.on('close', (code) => finish({ exitCode: code, output }));
  });
}

/** Head and tail, because a failing check's first lines and its summary are both load-bearing. */
export function clampOutput(text: string, max = MAX_OUTPUT_CHARS): string {
  if (text.length <= max) return text;
  const half = Math.floor((max - 40) / 2);
  return `${text.slice(0, half)}\n… [${text.length - half * 2} characters omitted] …\n${text.slice(-half)}`;
}

/**
 * The turn handed back to the agent after a failed check.
 *
 * Naming the command is disclosure, not control: the model is being told what
 * failed so it can fix the code, and knowing the string gives it no way to
 * change what the next cycle runs.
 */
export function buildFixPrompt(command: string, run: VerifyRun): string {
  const status = run.timedOut ? 'timed out' : `exited ${run.exitCode}`;
  return [
    "Your changes fail this project's checks.",
    '',
    `Command: ${command}  (${status})`,
    '',
    'Output:',
    run.output.trim() || '(no output)',
    '',
    'Fix the code so this command passes. Change the code the check is complaining about — do not edit, weaken, or disable the check itself, and do not try to run it yourself. Finish as usual when done; the check will be re-run automatically.',
  ].join('\n');
}
