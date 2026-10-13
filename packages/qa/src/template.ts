/**
 * Filling in a step's text: `{{input}}`, `{{secret:NAME}}`, `{{runId}}`, `${ENV}`.
 *
 * Secrets are kept apart from everything else on purpose. A secret's value is
 * typed into the page and nowhere else: never into a report, a log, a saved
 * fingerprint — and never into anything a model reads, which sees
 * `«secret:NAME»` instead (docs/QA_PLAN.md §8). So filling returns both the
 * value for the page and a redacted copy for everyone else, and remembers
 * every secret it used so `redact` can scrub text that came back from the page.
 */

export interface TemplateContext {
  inputs: Record<string, string>;
  /** Looks up a secret; undefined when it is not set. */
  secret: (name: string) => string | undefined;
  env: Record<string, string | undefined>;
  runId: string;
}

export interface Filled {
  /** What goes into the page. */
  value: string;
  /** What everyone else sees. */
  shown: string;
}

export class TemplateError extends Error {}

const PATTERN = /\{\{\s*([^}]+?)\s*\}\}|\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

export class Templates {
  /** Every secret value used so far, for `redact`. */
  private readonly used = new Map<string, string>();

  constructor(private readonly ctx: TemplateContext) {}

  fill(text: string): Filled {
    let shown = '';
    let value = '';
    let last = 0;
    for (const match of text.matchAll(PATTERN)) {
      const literal = text.slice(last, match.index);
      value += literal;
      shown += literal;
      last = match.index! + match[0].length;
      const [, expr, envName, envDefault] = match;
      if (envName !== undefined) {
        const v = this.ctx.env[envName] ?? envDefault;
        if (v === undefined) throw new TemplateError(`\${${envName}} is not set in the environment and has no default (write \${${envName}:-default}).`);
        value += v;
        shown += v;
        continue;
      }
      const e = expr!;
      if (e.startsWith('secret:')) {
        const name = e.slice('secret:'.length).trim();
        const v = this.ctx.secret(name);
        if (v === undefined) throw new TemplateError(`Secret ${name} is not set — add it to the environment or the secrets file.`);
        if (v) this.used.set(v, name);
        value += v;
        shown += `«secret:${name}»`;
      } else if (e === 'runId') {
        value += this.ctx.runId;
        shown += this.ctx.runId;
      } else if (e in this.ctx.inputs) {
        // An input may itself use templates (`email: qa+{{runId}}@x.test`).
        const inner = this.fill(this.ctx.inputs[e]!);
        value += inner.value;
        shown += inner.shown;
      } else {
        throw new TemplateError(`{{${e}}} is not an input of this flow. Inputs: ${Object.keys(this.ctx.inputs).join(', ') || 'none'}.`);
      }
    }
    value += text.slice(last);
    shown += text.slice(last);
    return { value, shown };
  }

  /** Scrub every secret used so far out of text read back from the page or a log. */
  redact(text: string): string {
    let out = text;
    // Longest first, so a secret that contains another is replaced whole.
    for (const [secret, name] of [...this.used].sort((a, b) => b[0].length - a[0].length)) {
      out = out.split(secret).join(`«secret:${name}»`);
    }
    return out;
  }
}

/** `KEY=value` lines, as in a `.env` file. Comments and blank lines are skipped; quotes are stripped. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2]!;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[m[1]!] = value;
  }
  return out;
}
