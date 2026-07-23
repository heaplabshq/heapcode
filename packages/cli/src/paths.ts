import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Personal, cross-project config: provider profiles, active profile, settings.
 * Overridable via HEAPCODE_HOME — lets tests run hermetically against a temp
 * dir instead of the real ~/.heapcode, and lets users relocate config.
 */
export function globalDir(): string {
  return process.env.HEAPCODE_HOME || join(homedir(), '.heapcode');
}

/** Project-scoped: conversation history, checkpoints, memory — matches the
 * existing `.heapcode/HEAPCODE.md` / `.heapcode/memory.md` convention. */
export function projectDir(cwd: string = process.cwd()): string {
  return join(cwd, '.heapcode');
}

export function configFile(): string {
  return join(globalDir(), 'config.json');
}

export function secretsFile(): string {
  return join(globalDir(), 'secrets.json');
}

export function conversationsFile(cwd?: string): string {
  return join(projectDir(cwd), 'conversations.json');
}
