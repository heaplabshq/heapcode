import type { NoteSummary, Vault } from './vault.js';
import { tagKey } from './vault.js';

/**
 * "Smart" order for a tag's notes — the order you'd read them in, which
 * dates can't give (an import stamps every note with the same moment) and
 * letters get wrong (Week 10 before Week 2).
 *
 * Inside a tag the notes form groups: the tag's own, then one per subtag one
 * level down, each shown under a heading. In each group its page comes first
 * — the note named like the tag, as a Notion parent page is — then pinned
 * notes, then the notes in the order that page links to them (Notion's own
 * order, or yours: reorder the links and the list follows), then the rest
 * by title, numbers as numbers. Subtag groups follow the order the tag's
 * page links to their pages.
 */
export interface ListGroup {
  /** The subtag, as written; the tag itself for its own notes. */
  tag: string;
  count: number;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Titles as a person sorts them: "Week 2" before "Week 10". */
export function naturalCompare(a: string, b: string): number {
  return collator.compare(a, b);
}

/** "🧠 AI/ML Self-Study Plan" and the tag "🧠 AI ML Self-Study Plan" are the same name. */
function plain(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

export async function smartOrder(
  vault: Vault,
  notes: NoteSummary[],
  tag: string,
): Promise<{ notes: (NoteSummary & { group: string })[]; groups: ListGroup[] }> {
  const key = tagKey(tag);
  const depth = key.split('/').length;

  // Each note's group: this tag, or the subtag one level below it that it's under.
  const groupOf = (n: NoteSummary): string => {
    let best: string | undefined;
    for (const t of n.tags) {
      const k = tagKey(t);
      if (k === key) return tag;
      if (k.startsWith(`${key}/`)) {
        const named = t
          .replace(/^#|#$/g, '')
          .split('/')
          .slice(0, depth + 1)
          .join('/');
        best ??= named;
      }
    }
    return best ?? tag;
  };
  const groups = new Map<string, NoteSummary[]>();
  for (const n of notes) {
    const g = groupOf(n);
    const list = groups.get(tagKey(g)) ?? [];
    if (!list.length) groups.set(tagKey(g), list);
    list.push(n);
    (n as NoteSummary & { group?: string }).group = g;
  }
  const nameOf = (k: string) => (groups.get(k)![0] as NoteSummary & { group: string }).group;

  /** A group's page, and the notes it links to, in order. */
  const homeOf = (k: string, members: NoteSummary[]) => {
    const want = plain(k.split('/').pop() ?? '');
    return members.find((n) => plain(n.title) === want);
  };
  const linkOrder = async (home: NoteSummary | undefined): Promise<string[]> => {
    if (!home) return [];
    const got = await vault.get({ id: home.id }).catch(() => undefined);
    return (got?.links ?? []).map((l) => l.id).filter((id): id is string => !!id);
  };

  const ordered = new Map<string, NoteSummary[]>();
  const homes = new Map<string, NoteSummary | undefined>();
  for (const [k, members] of groups) {
    const home = homeOf(k, members);
    homes.set(k, home);
    // A database's rows come in whatever order Notion's view had — often
    // none. Its own numbering says more: a column with a distinct number per
    // row (Day #, Order), else the titles (Week 01…38), numbers as numbers.
    const table = home ? await rowTable(vault, home) : undefined;
    const byColumn = table && numberedColumn(table);
    const links = table ? [] : await linkOrder(home);
    const rank = byColumn
      ? new Map(
          members
            .filter((n) => byColumn.has(plain(n.title)))
            .sort((a, b) => byColumn.get(plain(a.title))! - byColumn.get(plain(b.title))!)
            .map((n, i) => [n.id, i] as const),
        )
      : new Map(links.map((id, i) => [id, i] as const));
    const sorted = [...members].sort((a, b) => {
      const tier = (n: NoteSummary) => (n === home ? 0 : n.pinned ? 1 : rank.has(n.id) ? 2 : 3);
      const d = tier(a) - tier(b);
      if (d) return d;
      if (tier(a) === 2) return rank.get(a.id)! - rank.get(b.id)!;
      return naturalCompare(a.title, b.title);
    });
    ordered.set(k, sorted);
  }

  // Subtag groups in the order the tag's own page links to their pages.
  const rootLinks = await linkOrder(homes.get(key));
  const rootRank = new Map(rootLinks.map((id, i) => [id, i] as const));
  const keys = [...groups.keys()].sort((a, b) => {
    if (a === key) return -1;
    if (b === key) return 1;
    const ra = rootRank.get(homes.get(a)?.id ?? '') ?? Infinity;
    const rb = rootRank.get(homes.get(b)?.id ?? '') ?? Infinity;
    return ra !== rb ? ra - rb : naturalCompare(nameOf(a), nameOf(b));
  });

  return {
    notes: keys.flatMap((k) => ordered.get(k)!) as (NoteSummary & { group: string })[],
    groups: keys.map((k) => ({ tag: nameOf(k), count: groups.get(k)!.length })),
  };
}

/**
 * A page holding a table whose first column links each row's page — what a
 * Notion database imports as. Rows as `{ title → cells }`, header first.
 */
async function rowTable(
  vault: Vault,
  home: NoteSummary,
): Promise<{ header: string[]; rows: Map<string, string[]> } | undefined> {
  const text = await vault
    .read({ id: home.id })
    .then((r) => r.content)
    .catch(() => '');
  const lines = text.split('\n').filter((l) => /^\s*\|/.test(l));
  if (lines.length < 3) return undefined;
  const cells = (l: string) =>
    l
      .trim()
      .replace(/^\||\|$/g, '')
      .split(/(?<!\\)\|/)
      .map((c) => c.trim());
  const rows = new Map<string, string[]>();
  for (const l of lines.slice(2)) {
    const row = cells(l);
    const link = /^\[\[([^\]|]+)(?:\|[^\]]*)?\]\]$/.exec(row[0] ?? '');
    if (link) rows.set(plain(link[1]!), row);
  }
  return rows.size ? { header: cells(lines[0]!), rows } : undefined;
}

/** The first column that numbers every row differently, as `{ title → number }`. */
function numberedColumn(table: {
  header: string[];
  rows: Map<string, string[]>;
}): Map<string, number> | undefined {
  for (let col = 1; col < table.header.length; col++) {
    const values = new Map<string, number>();
    for (const [title, row] of table.rows) {
      const n = Number(/^-?\d+(?:\.\d+)?$/.test(row[col] ?? '') ? row[col] : NaN);
      if (Number.isNaN(n)) break;
      values.set(title, n);
    }
    if (values.size === table.rows.size && new Set(values.values()).size === values.size)
      return values;
  }
  return undefined;
}
