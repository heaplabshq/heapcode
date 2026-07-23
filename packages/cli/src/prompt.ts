import * as readline from 'node:readline';

/**
 * A prompt sequence needs ONE shared readline.Interface for its whole
 * lifetime, not one per question. Piped/non-TTY stdin (scripts, CI, or the
 * fully-scripted answers this CLI's own tests drive) delivers input in
 * chunks, not per-keystroke — a readline.Interface reads and internally
 * buffers a whole chunk, but only hands back the first line before an
 * `ask()` call would `rl.close()` it; closing discards whatever of that
 * chunk was already buffered but unread, so a second `createInterface` call
 * never sees it and hangs waiting for input that already arrived. A real
 * interactive TTY session doesn't hit this (keystrokes arrive one at a
 * time), but a single shared interface is correct either way and is what
 * closes the gap for non-interactive use.
 */
export class Prompter {
  private readonly rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  ask(question: string, defaultValue?: string): Promise<string> {
    const suffix = defaultValue ? ` (${defaultValue})` : '';
    return new Promise((resolve) => {
      this.rl.question(`${question}${suffix}: `, (answer) => resolve(answer.trim() || defaultValue || ''));
    });
  }

  /** Masked prompt for secrets — echoes `*` per keystroke instead of the real character. */
  askSecret(question: string): Promise<string> {
    const rlAny = this.rl as unknown as { _writeToOutput?: (s: string) => void };
    const restore = rlAny._writeToOutput;
    return new Promise((resolve) => {
      process.stdout.write(`${question}: `);
      rlAny._writeToOutput = (chunk: string) => {
        if (chunk === '\r\n' || chunk === '\n') process.stdout.write(chunk);
        else process.stdout.write('*'.repeat(chunk.length));
      };
      this.rl.question('', (answer) => {
        rlAny._writeToOutput = restore;
        resolve(answer.trim());
      });
    });
  }

  /** Numbered single-select from a list of labels; returns the chosen index. */
  async select(question: string, choices: string[], defaultIndex = 0): Promise<number> {
    console.log(question);
    choices.forEach((c, i) => console.log(`  ${i + 1}. ${c}`));
    const answer = await this.ask(`Choose 1-${choices.length}`, String(defaultIndex + 1));
    const n = Number.parseInt(answer, 10);
    if (Number.isNaN(n) || n < 1 || n > choices.length) return defaultIndex;
    return n - 1;
  }

  close(): void {
    this.rl.close();
  }
}
