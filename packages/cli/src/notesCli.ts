import { resolve } from 'node:path';
import {
  COMMANDS,
  NoteError,
  Vault,
  checkArgs,
  defaultVaultRoot,
  findCommand,
  importBear,
  importBearExport,
  importMarkdownFolder,
  importObsidian,
  serveNotesMcp,
  writeNotesSettings,
  type Command,
  type ImportResult,
} from '@heapcode/notes-host';
import { cliVersion } from './version.js';

/**
 * `heapcode notes …` — Heapnotes from the terminal, and its MCP server.
 *
 * Every subcommand but `vault`, `import` and `mcp` is a row of notes-host's
 * command table, so this file only turns argv into arguments and results into
 * text. Output and exit codes follow bearcli:
 * `--format tsv|csv|json`, `--fields`, errors as `{"error":{"code","message"}}`
 * under --format json, and 0 ok / 1 failed / 64 usage.
 */
export async function runNotes(argv: string[]): Promise<number> {
  let parsed: Parsed;
  try {
    parsed = parseArgv(argv);
  } catch (err) {
    return usage((err as Error).message);
  }
  const [sub, ...positionals] = parsed.positionals;
  if (sub === undefined || sub === 'help' || parsed.flags.help !== undefined) {
    printNotesHelp();
    return 0;
  }

  const format = flagString(parsed, 'format') ?? 'tsv';
  if (!['tsv', 'csv', 'json'].includes(format))
    return usage(`--format is tsv, csv or json, not "${format}".`);

  if (sub === 'vault') return vaultCommand(positionals[0], parsed);

  let vault: Vault | undefined;
  try {
    vault = await Vault.open({ root: vaultRoot(parsed), scope: scopeOf(parsed) });
    if (sub === 'mcp') {
      await serveNotesMcp(vault, cliVersion() ?? '0.0.0');
      return 0;
    }
    if (sub === 'import') return await importCommand(vault, positionals, parsed, format);

    const cmd = findCommand({ cli: sub });
    if (!cmd) return usage(`Unknown command \`heapcode notes ${sub}\`.`);
    const args = checkArgs(cmd, await argsFor(cmd, positionals, parsed));
    const result = await cmd.run(vault, args);
    print(cmd, result, format, flagString(parsed, 'fields'));
    return 0;
  } catch (err) {
    return fail(err, format);
  } finally {
    vault?.close();
  }
}

function printNotesHelp(): void {
  const rows = COMMANDS.map((c) => {
    const pos = (c.positional ?? []).map((p) => `<${p}>`).join(' ');
    return `  heapcode notes ${`${c.cli} ${pos}`.trim().padEnd(30)} ${c.description.split(/(?<=\.)\s/)[0]}`;
  });
  console.log(`heapcode notes — Heapnotes: your notes as a folder of Markdown files

Usage:
  heapcode notes vault [folder]                Show the vault, or make this folder the default
  heapcode notes import markdown <folder>      Copy in a folder of .md files (layout and linked files kept)
  heapcode notes import obsidian <vault>       Copy in an Obsidian vault, attachments included
  heapcode notes import bear [export-folder]   From Bear: through bearcli, or from a Bear export (Markdown/TextBundle)
  heapcode notes mcp                           Serve the notes to an AI app over MCP (stdio)
${rows.join('\n')}

A note is named by id (the first argument), or --title "…" or --path "…".
Text arguments read stdin when left out or given as "-".

Every command:
  --vault <folder>         Which vault (else $HEAPNOTES_VAULT, else the default, else ~/Heapnotes)
  --only-tags a,b          See only notes with these tags (subtags included)
  --exclude-tags c,d       Never see notes with these tags — e.g. keep #private from an AI
  --format tsv|csv|json    Output (default tsv). json errors: {"error":{"code","message"}}
  --fields f1,f2|all       Columns for lists

Exit codes: 0 ok, 1 the command failed, 64 usage.

To give Claude Desktop (or any MCP app) your notes, add a server:
  { "command": "heapcode", "args": ["notes", "mcp", "--exclude-tags", "private"] }`);
}

// ── Arguments ─────────────────────────────────────────────────────────────

interface Parsed {
  positionals: string[];
  /** Repeated flags keep every value. A flag with no value is `true`. */
  flags: Record<string, (string | true)[]>;
}

const BOOLEAN_FLAGS = new Set(['help', 'h', 'all', 'delete', 'pinned', 'case-sensitive']);

function parseArgv(argv: string[]): Parsed {
  const out: Parsed = { positionals: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') {
      out.positionals.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--') || (a.startsWith('-') && a.length === 2 && a !== '-')) {
      const eq = a.indexOf('=');
      const name = (eq > 0 ? a.slice(0, eq) : a).replace(/^--?/, '');
      let value: string | true;
      if (eq > 0) value = a.slice(eq + 1);
      else if (
        BOOLEAN_FLAGS.has(name) ||
        argv[i + 1] === undefined ||
        (argv[i + 1]!.startsWith('--') && argv[i + 1]!.length > 2)
      )
        value = true;
      else value = argv[++i]!;
      (out.flags[name] ??= []).push(value);
      continue;
    }
    out.positionals.push(a);
  }
  return out;
}

function flagString(p: Parsed, name: string): string | undefined {
  const v = p.flags[name]?.at(-1);
  return typeof v === 'string' ? v : undefined;
}

const ALIASES: Record<string, string> = { n: 'limit', t: 'title' };

const GLOBAL_FLAGS = new Set(['vault', 'format', 'fields', 'only-tags', 'exclude-tags', 'into']);

/** Flags become the command's arguments: `--insert-before` → `insertBefore`, `--tag a --tag b` → `tags`. */
async function argsFor(
  cmd: Command,
  positionals: string[],
  p: Parsed,
): Promise<Record<string, unknown>> {
  const args: Record<string, unknown> = {};
  const props = cmd.input.properties;
  for (const [flag, values] of Object.entries(p.flags)) {
    if (GLOBAL_FLAGS.has(flag)) continue;
    let key = ALIASES[flag] ?? flag.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    if (!props[key] && key === 'tag' && props.tags?.type === 'array') key = 'tags';
    const schema = props[key];
    if (!schema) throw new UsageError(`\`heapcode notes ${cmd.cli}\` has no --${flag}.`);
    if (schema.type === 'array')
      args[key] = values.flatMap((v) =>
        v === true
          ? []
          : v
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
      );
    else args[key] = values.at(-1);
  }
  // `--title` or `--path` names the note, so the words that follow fill the
  // slots after it: `tag-add --title Plan work` is the tag, not an id.
  let names = cmd.positional ?? [];
  if (names[0] === 'id' && (args.title !== undefined || args.path !== undefined))
    names = names.slice(1);
  // `heapcode notes search meeting notes` means one query, not two arguments.
  const last = names.at(-1);
  if ((last === 'query' || last === 'text') && positionals.length > names.length) {
    positionals = [
      ...positionals.slice(0, names.length - 1),
      positionals.slice(names.length - 1).join(' '),
    ];
  }
  if (positionals.length > names.length)
    throw new UsageError(
      `Too many arguments for \`heapcode notes ${cmd.cli}\`: it takes ${names.map((n) => `<${n}>`).join(' ') || 'none'}.`,
    );
  names.forEach((name, i) => {
    const v = positionals[i];
    if (v !== undefined) args[name] = v;
  });
  // Text from a pipe: `pbpaste | heapcode notes create`.
  for (const name of ['text', 'base64'] as const) {
    if (!(name in props)) continue;
    // Only when asked for (`-`) or required — never a surprise wait on a stdin nobody closes.
    const wanted =
      args[name] === '-' || (args[name] === undefined && cmd.input.required?.includes(name));
    if (wanted && !process.stdin.isTTY)
      args[name] =
        name === 'base64'
          ? (await readStdin()).toString('base64')
          : (await readStdin()).toString('utf8');
    else if (args[name] === '-') args[name] = undefined;
  }
  if (cmd.cli === 'attach' && args.base64 === undefined)
    throw new UsageError('Pipe the file in: `heapcode notes attach <id> photo.png < photo.png`.');
  return args;
}

async function readStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

class UsageError extends Error {}

// ── Vault ─────────────────────────────────────────────────────────────────

function vaultRoot(p: Parsed): string {
  const given = flagString(p, 'vault');
  return given ? resolve(given) : defaultVaultRoot();
}

function scopeOf(p: Parsed): { onlyTags: string[]; excludeTags: string[] } {
  const list = (name: string) =>
    (p.flags[name] ?? [])
      .flatMap((v) => (v === true ? [] : v.split(',')))
      .map((s) => s.trim())
      .filter(Boolean);
  return { onlyTags: list('only-tags'), excludeTags: list('exclude-tags') };
}

function vaultCommand(folder: string | undefined, p: Parsed): number {
  if (!folder) {
    console.log(vaultRoot(p));
    return 0;
  }
  const root = resolve(folder);
  writeNotesSettings({ vault: root });
  console.log(`Default vault: ${root}`);
  return 0;
}

async function importCommand(
  vault: Vault,
  positionals: string[],
  p: Parsed,
  format: string,
): Promise<number> {
  const [kind, source] = positionals;
  const into = flagString(p, 'into');
  const opts = into ? { into } : {};
  let result: ImportResult;
  switch (kind) {
    case 'markdown':
      if (!source) return usage('Which folder? `heapcode notes import markdown ~/Notes`');
      result = await importMarkdownFolder(vault, source, opts);
      break;
    case 'obsidian':
      if (!source) return usage('Which vault? `heapcode notes import obsidian ~/Obsidian/MyVault`');
      result = await importObsidian(vault, source, opts);
      break;
    case 'bear':
      result = source ? await importBearExport(vault, source, opts) : await importBear(vault, opts);
      break;
    default:
      return usage(
        'Import from markdown, obsidian or bear: `heapcode notes import markdown <folder>`.',
      );
  }
  if (format === 'json') {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(
      `Imported ${result.notes} note${result.notes === 1 ? '' : 's'} and ${result.attachments} attachment${result.attachments === 1 ? '' : 's'} into ${vault.root}.`,
    );
    for (const s of result.skipped) console.log(`  skipped ${s.source}: ${s.reason}`);
  }
  return 0;
}

// ── Output ────────────────────────────────────────────────────────────────

function print(
  cmd: Command,
  result: unknown,
  format: string,
  fieldsFlag: string | undefined,
): void {
  if (format === 'json') {
    // Lists print as bare arrays, like bearcli.
    let value = isPage(result) ? result.notes : result;
    if (fieldsFlag && fieldsFlag !== 'all' && Array.isArray(value)) {
      const fields = pickFields(value as Record<string, unknown>[], fieldsFlag, undefined);
      value = (value as Record<string, unknown>[]).map((r) =>
        Object.fromEntries(fields.map((f) => [f, r[f]])),
      );
    }
    console.log(JSON.stringify(value ?? null, null, 2));
    return;
  }
  if (cmd.cli === 'cat' && result && typeof result === 'object' && 'content' in result) {
    process.stdout.write(String((result as { content: string }).content));
    return;
  }
  const rows = isPage(result)
    ? result.notes
    : Array.isArray(result)
      ? result
      : cmd.cli === 'outline'
        ? (result as { sections: unknown[] }).sections
        : null;
  if (rows) {
    const fields = pickFields(
      rows as Record<string, unknown>[],
      fieldsFlag,
      cmd.fields ?? (cmd.cli === 'outline' ? ['address', 'offset', 'length'] : undefined),
    );
    printTable(rows as Record<string, unknown>[], fields, format);
    if (rows.length === 0 && format === 'tsv') console.error('No results.');
    return;
  }
  if (!cmd.readOnly) {
    // A write says which note it touched; nothing more.
    const id =
      result && typeof result === 'object' && 'id' in result
        ? (result as { id: unknown }).id
        : undefined;
    if (typeof id === 'string') console.log(id);
    else if (result && typeof result === 'object')
      printKeyValues(result as Record<string, unknown>, format);
    return;
  }
  printKeyValues(result as Record<string, unknown>, format);
}

function isPage(r: unknown): r is { notes: Record<string, unknown>[]; total: number } {
  return !!r && typeof r === 'object' && Array.isArray((r as { notes?: unknown }).notes);
}

function pickFields(
  rows: Record<string, unknown>[],
  flag: string | undefined,
  defaults: string[] | undefined,
): string[] {
  const all = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  if (flag === 'all') return all;
  if (flag)
    return flag
      .split(',')
      .map((f) => f.trim())
      .filter(Boolean);
  return defaults ?? all;
}

function printTable(rows: Record<string, unknown>[], fields: string[], format: string): void {
  if (format === 'csv') {
    console.log(fields.map(csvCell).join(','));
    for (const r of rows) console.log(fields.map((f) => csvCell(cell(r[f]))).join(','));
    return;
  }
  for (const r of rows)
    console.log(fields.map((f) => cell(r[f]).replace(/[\t\r\n]+/g, ' ')).join('\t'));
}

function printKeyValues(obj: Record<string, unknown>, format: string): void {
  const entries = Object.entries(obj ?? {});
  if (format === 'csv') {
    console.log(entries.map(([k]) => csvCell(k)).join(','));
    console.log(entries.map(([, v]) => csvCell(cell(v))).join(','));
    return;
  }
  for (const [k, v] of entries) console.log(`${k}\t${cell(v).replace(/[\t\r\n]+/g, ' ')}`);
}

function cell(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (Array.isArray(v))
    return v.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(',');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function csvCell(s: string): string {
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function fail(err: unknown, format: string): number {
  if (err instanceof UsageError) return usage(err.message, format);
  const e =
    err instanceof NoteError
      ? err
      : new NoteError('io', err instanceof Error ? err.message : String(err));
  if (format === 'json') console.log(JSON.stringify(e.toJSON()));
  else console.error(e.message);
  return 1;
}

function usage(message: string, format = 'tsv'): number {
  if (format === 'json') console.log(JSON.stringify({ error: { code: 'usage', message } }));
  else console.error(`${message}\nRun \`heapcode notes help\` for the commands.`);
  return 64;
}
