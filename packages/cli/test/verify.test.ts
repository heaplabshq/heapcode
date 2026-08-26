import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildFixPrompt, clampOutput, parseVerifyCommand, runVerifyCommand } from '../src/verify.js';

/**
 * The security-relevant half of `--verify` lives in the parser and the
 * spawner: one command, argv-style, no shell. These are the unit-level
 * proofs; headless.test.ts proves the same properties hold across a real
 * fix loop with a model in it.
 */
describe('parseVerifyCommand', () => {
  it('splits a plain command into argv', () => {
    expect(parseVerifyCommand('make check')).toEqual(['make', 'check']);
    expect(parseVerifyCommand('  npm   run   lint  ')).toEqual(['npm', 'run', 'lint']);
  });

  it('honours quoting, so an argument with spaces survives as one argument', () => {
    expect(parseVerifyCommand(`pytest -k 'not slow'`)).toEqual(['pytest', '-k', 'not slow']);
    expect(parseVerifyCommand('node "/path with spaces/check.js" a')).toEqual(['node', '/path with spaces/check.js', 'a']);
    expect(parseVerifyCommand('echo ""')).toEqual(['echo', '']);
  });

  it.each(['make check && rm -rf /', 'lint; touch pwned', 'a | b', 'echo $(whoami)', 'echo `whoami`', 'check > out.txt'])(
    'refuses %s — there is no shell to interpret it, and a chain would break "exactly one command"',
    (spec) => {
      expect(() => parseVerifyCommand(spec)).toThrow(/without a shell/);
      // Named as written: "&&" reported as "&" would send someone hunting for the wrong character.
      if (spec.includes('&&')) expect(() => parseVerifyCommand(spec)).toThrow(/"&&"/);
    },
  );

  it('allows a shell operator that is quoted, since it is then just a literal argument', () => {
    expect(parseVerifyCommand(`grep -e "a|b" src`)).toEqual(['grep', '-e', 'a|b', 'src']);
  });

  it('rejects an unbalanced quote rather than guessing where the argument ended', () => {
    expect(() => parseVerifyCommand(`pytest -k 'not slow`)).toThrow(/unbalanced/);
  });

  it('rejects an empty command', () => {
    expect(() => parseVerifyCommand('   ')).toThrow(/needs a command/);
  });
});

describe('runVerifyCommand', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'heapcode-verify-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('spawns argv directly: the arguments arrive verbatim, unexpanded and uninterpreted', async () => {
    const script = join(dir, 'record.cjs');
    await writeFile(script, `require('node:fs').writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)));\n`);
    const out = join(dir, 'argv.json');

    // $HOME and the asterisk would both be rewritten by a shell; nothing here rewrites them.
    const run = await runVerifyCommand([process.execPath, script, out, '$HOME', '*.ts'], dir);

    expect(run.exitCode).toBe(0);
    expect(JSON.parse(await readFile(out, 'utf8'))).toEqual(['$HOME', '*.ts']);
  });

  it('captures stdout and stderr together, with the exit code', async () => {
    const script = join(dir, 'fail.cjs');
    await writeFile(script, `console.log('checking');\nconsole.error('E501 line too long');\nprocess.exit(2);\n`);

    const run = await runVerifyCommand([process.execPath, script], dir);

    expect(run.exitCode).toBe(2);
    expect(run.output).toContain('checking');
    expect(run.output).toContain('E501 line too long');
  });

  it('reports a command that cannot be started as a spawn failure, not as a check that failed', async () => {
    const run = await runVerifyCommand([join(dir, 'no-such-binary')], dir);

    expect(run.spawnFailed).toBe(true);
    expect(run.exitCode).toBeNull();
  });

  it('kills a command that hangs instead of hanging the run', async () => {
    const script = join(dir, 'hang.cjs');
    await writeFile(script, `setInterval(() => {}, 1000);\n`);

    const run = await runVerifyCommand([process.execPath, script], dir, 300);

    expect(run.timedOut).toBe(true);
    expect(run.output).toContain('timed out');
  });
});

describe('output handling', () => {
  it('clamps a flood to head and tail, saying how much was dropped', () => {
    const clamped = clampOutput(`START${'x'.repeat(5_000)}END`, 200);
    expect(clamped.startsWith('START')).toBe(true);
    expect(clamped.endsWith('END')).toBe(true);
    expect(clamped).toContain('characters omitted');
    expect(clamped.length).toBeLessThan(300);
  });

  it("names the command and the failure in the model's turn, and tells it not to touch the check itself", () => {
    const prompt = buildFixPrompt('make check', { exitCode: 1, output: 'E501 line too long (106 > 100)' });
    expect(prompt).toContain('make check');
    expect(prompt).toContain('exited 1');
    expect(prompt).toContain('E501 line too long');
    expect(prompt).toMatch(/do not edit, weaken, or disable the check/);
  });
});
