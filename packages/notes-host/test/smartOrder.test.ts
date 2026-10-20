import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Vault, naturalCompare, smartOrder } from '../src/index.js';

let root: string;
let vault: Vault;
const put = (rel: string, text: string) => {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), text);
};

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'heapnotes-smart-'));
  // A Notion-shaped tree: the plan's page links its pages in its own order.
  put('Plan.md', '# 🧠 AI/ML Plan\n#🧠 AI ML Plan#\n\n[[Schedule]] [[Tracker]] [[Library]]\n');
  put('Library.md', '# Library\n#🧠 AI ML Plan#\n');
  put('Schedule.md', '# Schedule\n#🧠 AI ML Plan#\n');
  put('Aside.md', '# Aside\n#🧠 AI ML Plan#\n');
  put('Tracker.md', '# Tracker\n#🧠 AI ML Plan/Tracker#\n\n[[Week 2]] [[Week 1]]\n');
  put('W1.md', '# Week 1\n#🧠 AI ML Plan/Tracker#\n');
  put('W2.md', '# Week 2\n#🧠 AI ML Plan/Tracker#\n');
  put('W10.md', '# Week 10\n#🧠 AI ML Plan/Tracker#\n');
  put('Log.md', '# Log\n#🧠 AI ML Plan/Log#\n');
  put('D9.md', '# Day 9\n#🧠 AI ML Plan/Log#\n');
  put('D10.md', '# Day 10\n#🧠 AI ML Plan/Log#\n');
  vault = await Vault.open({ root, indexFile: ':memory:', staleMs: 0 });
});
afterEach(() => {
  vault.close();
  rmSync(root, { recursive: true, force: true });
});

describe('naturalCompare', () => {
  it('reads numbers as numbers', () => {
    expect(['Week 10', 'Week 2', 'week 1'].sort(naturalCompare)).toEqual([
      'week 1',
      'Week 2',
      'Week 10',
    ]);
  });
});

describe('smartOrder', () => {
  it("puts each group's page first, then its links' order, then the rest by title", async () => {
    const { notes } = await vault.list({ tag: '🧠 AI ML Plan', limit: 100 });
    const smart = await smartOrder(vault, notes, '🧠 AI ML Plan');
    expect(smart.notes.map((n) => n.title)).toEqual([
      '🧠 AI/ML Plan', // the tag's page, though its title has a slash the tag doesn't
      'Schedule',
      'Library',
      'Aside', // not linked: after the linked, by title
      'Tracker', // subtags in the order the page links their pages
      'Week 2',
      'Week 1',
      'Week 10',
      'Log', // not linked from the page: after the linked group
      'Day 9',
      'Day 10',
    ]);
    expect(smart.groups).toEqual([
      { tag: '🧠 AI ML Plan', count: 4 },
      { tag: '🧠 AI ML Plan/Tracker', count: 4 },
      { tag: '🧠 AI ML Plan/Log', count: 3 },
    ]);
  });

  it('keeps pinned notes just under the page', async () => {
    await vault.pin({ title: 'Aside' }, true);
    const { notes } = await vault.list({ tag: '🧠 AI ML Plan', limit: 100 });
    const smart = await smartOrder(vault, notes, '🧠 AI ML Plan');
    expect(smart.notes.slice(0, 3).map((n) => n.title)).toEqual([
      '🧠 AI/ML Plan',
      'Aside',
      'Schedule',
    ]);
  });

  it('orders a database by its numbering column, else by title', async () => {
    put(
      'Days.md',
      '# Days\n#Days#\n\n| Name | Day # |\n| --- | --- |\n| [[Wed]] | 3 |\n| [[Mon]] | 1 |\n| [[Tue]] | 2 |\n',
    );
    for (const d of ['Mon', 'Tue', 'Wed']) put(`${d}.md`, `# ${d}\n#Days#\n`);
    put(
      'Weeks.md',
      '# Weeks\n#Weeks#\n\n| Name | Hours |\n| --- | --- |\n| [[Week 10]] | 7 |\n| [[Week 2]] | 7 |\n',
    );
    put('Wk10.md', '# Week 10\n#Weeks#\n');
    put('Wk2.md', '# Week 2\n#Weeks#\n');
    const order = async (tag: string) =>
      (await smartOrder(vault, (await vault.list({ tag, limit: 100 })).notes, tag)).notes.map(
        (n) => n.title,
      );
    expect(await order('Days')).toEqual(['Days', 'Mon', 'Tue', 'Wed']); // by "Day #", not the table's order
    expect(await order('Weeks')).toEqual(['Weeks', 'Week 2', 'Week 10']); // hours repeat: by title
  });
});
