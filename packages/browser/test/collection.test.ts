import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserToolExecutor } from '../src/agent/executor.js';
import { mergeTable } from '../src/shared/dataset.js';
import type { Dataset } from '../src/shared/dataset.js';
import type { PageSnapshot, TableSummary } from '../src/shared/snapshot.js';

/**
 * Collecting rows across pages.
 *
 * The task this whole mechanism exists for -- "compare these fifty listings" --
 * and until now nothing tested it end to end. Both bugs found in this area were
 * the same shape: the feature ran, produced nothing or nearly nothing, and said
 * so in a way nobody read.
 */

function table(headers: string[], rows: string[][], label?: string): TableSummary {
  return { label, headers, columns: headers.length, rows: rows.length, sample: rows.slice(0, 5), body: rows };
}

function snapshot(tables: TableSummary[], url = 'https://shop.example.com/p1'): PageSnapshot {
  return {
    url,
    title: 'Results',
    viewport: { width: 1440, height: 900, scrollY: 0, scrollHeight: 4000 },
    text: 'Results',
    controls: [],
    tables,
    generation: 1,
  };
}

function stubChrome(snapshots: PageSnapshot[]) {
  const sendMessage = vi.fn();
  for (const page of snapshots) sendMessage.mockResolvedValueOnce({ ok: true, kind: 'snapshot', snapshot: page });
  vi.stubGlobal('chrome', {
    tabs: {
      query: vi.fn().mockResolvedValue([{ id: 1, url: 'https://shop.example.com/p1' }]),
      sendMessage,
    },
    permissions: { contains: vi.fn().mockResolvedValue(true) },
    scripting: { executeScript: vi.fn().mockResolvedValue([]) },
  });
}

const call = (args: Record<string, unknown> = {}) => ({ id: 'c1', name: 'extract_data', args });

const PHONES = ['Name', 'Price'];
const page1 = [['Galaxy M07', '₹11,499'], ['Nord CE6 Lite', '₹30,999'], ['iPhone Air', '₹1,01,900']];
const page2 = [['Motorola G57', '₹21,999'], ['Redmi 15C', '₹20,499'], ['Nokia 130', '₹1,949']];

afterEach(() => vi.unstubAllGlobals());

describe('collecting across pages', () => {
  it('adds page two to page one rather than replacing it', async () => {
    stubChrome([
      snapshot([table(PHONES, page1)]),
      snapshot([table(PHONES, page2)], 'https://shop.example.com/p2'),
    ]);
    let latest: Dataset | undefined;
    const executor = new BrowserToolExecutor('compare them', { onData: (d) => (latest = d) });

    await executor.execute(call());
    await executor.execute(call());

    expect(latest?.rows).toHaveLength(6);
    expect(latest?.sources).toHaveLength(2);
  });

  /** Pagination overlaps constantly: a page 2 that repeats page 1's last item. */
  it('does not collect the same row twice', async () => {
    stubChrome([
      snapshot([table(PHONES, page1)]),
      snapshot([table(PHONES, [page1[2]!, ...page2])], 'https://shop.example.com/p2'),
    ]);
    let latest: Dataset | undefined;
    const executor = new BrowserToolExecutor('compare them', { onData: (d) => (latest = d) });

    await executor.execute(call());
    await executor.execute(call());

    expect(latest?.rows).toHaveLength(6);
  });

  /**
   * The data-loss bug this file was written for.
   *
   * Detected lists are ranked, and which block ranks highest can change between
   * pages -- a sponsored carousel, a "customers also bought" strip. Taking the
   * first table on page two handed the merge different columns, and its answer
   * to that is to start again: every row gathered so far, silently discarded,
   * halfway through the one task this feature exists for.
   */
  it('keeps to the shape it is collecting when the page ranks another first', async () => {
    const carousel = table(['Name', 'Price', 'Rating'], [
      ['Sponsored A', '₹999', '4.1'],
      ['Sponsored B', '₹899', '4.0'],
      ['Sponsored C', '₹799', '3.9'],
    ]);
    stubChrome([
      snapshot([table(PHONES, page1)]),
      // Page two ranks the carousel above the results.
      snapshot([carousel, table(PHONES, page2)], 'https://shop.example.com/p2'),
    ]);
    let latest: Dataset | undefined;
    const executor = new BrowserToolExecutor('compare them', { onData: (d) => (latest = d) });

    await executor.execute(call());
    const second = await executor.execute(call());

    expect(latest?.headers).toEqual(PHONES);
    expect(latest?.rows).toHaveLength(6);
    expect(second.content).not.toMatch(/started again/);
  });

  /** An index the model asked for is obeyed, even mid-collection. */
  it('still obeys an explicit table number', async () => {
    const other = table(['Spec', 'Value'], [['Weight', '4kg'], ['Height', '17cm'], ['Width', '9cm']]);
    stubChrome([
      snapshot([table(PHONES, page1)]),
      snapshot([table(PHONES, page2), other], 'https://shop.example.com/p2'),
    ]);
    let latest: Dataset | undefined;
    const executor = new BrowserToolExecutor('compare them', { onData: (d) => (latest = d) });

    await executor.execute(call());
    await executor.execute(call({ table: 1 }));

    expect(latest?.headers).toEqual(['Spec', 'Value']);
  });

  it('reports the running total, not the rows, so they are not read back', async () => {
    stubChrome([
      snapshot([table(PHONES, page1)]),
      snapshot([table(PHONES, page2)], 'https://shop.example.com/p2'),
    ]);
    const executor = new BrowserToolExecutor('compare them');

    await executor.execute(call());
    const second = await executor.execute(call());

    expect(second.content).toMatch(/6 row\(s\)/);
    expect(second.content).toMatch(/do not need to repeat/);
  });
});

/**
 * The merge itself.
 *
 * It took a `TableSummary` and folded in its `sample` -- the five-row preview
 * built for the snapshot -- so a caller passing a table straight in collected
 * five rows per page and nothing said so. It is told which rows it means now.
 */
describe('merging rows', () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => [`Item ${i}`, `${i}`]);

  it('takes every row it is given', () => {
    const merged = mergeTable(undefined, { headers: PHONES, rows: rows(40) }, 'p1');
    expect(merged.dataset.rows).toHaveLength(40);
  });

  it('starts again, and says so, when the columns are different', () => {
    const first = mergeTable(undefined, { headers: PHONES, rows: rows(3) }, 'p1');
    const second = mergeTable(first.dataset, { headers: ['A', 'B', 'C'], rows: [['1', '2', '3']] }, 'p2');
    expect(second.restarted).toBe(true);
    expect(second.dataset.rows).toHaveLength(1);
  });

  it('does not call the first collection a restart', () => {
    expect(mergeTable(undefined, { headers: PHONES, rows: rows(2) }, 'p1').restarted).toBe(false);
  });
});
