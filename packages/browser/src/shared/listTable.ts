import type { TableSummary } from './snapshot.js';

/**
 * Turning a repeated block of a page into rows.
 *
 * `extract_data` used to see only real `<table>` markup, which meant it saw
 * nothing at all on the pages people actually ask it about: a search results
 * page, a product grid, a job board, a list of flights. Those are repeated
 * `<div>`s, and have been for fifteen years. So the request this whole feature
 * exists for -- "compare these on price" -- fell back to the model writing a
 * price list in prose, which is exactly the outcome collecting rows was built
 * to replace: plausible, unverifiable, and impossible to sort.
 *
 * Finding the repetition is structural and differs per driver; deciding what a
 * row *is* does not, so it lives here and both paths share it. The fields are
 * fixed and few on purpose. A general "infer the columns" pass produces a
 * different shape on every page, which breaks the one thing that makes
 * collection worth having -- rows from page two merging with rows from page
 * one.
 */

export interface ListItem {
  /** The heading or link text, when the structure named one. */
  title?: string;
  /** Every line of text inside the item, in document order. */
  lines: string[];
  /** The item's own link, when it has one. */
  href?: string;
}

/**
 * A price, as written on a page anywhere.
 *
 * Symbol or code, then digits with the separators of any locale. Deliberately
 * not anchored: a price sits inside a sentence as often as it sits alone. The
 * first match in an item wins, which is what picks the selling price out of a
 * card that also shows a struck-through list price -- the current one is
 * written first on every shop that does this.
 */
const PRICE =
  /(?:₹|Rs\.?|\$|£|€|¥|₩|R\$|A\$|C\$|USD|EUR|GBP|INR|JPY|AUD|CAD)\s?\d[\d.,]*(?:\s?(?:lakh|crore|k|m|bn))?/i;

/** A star rating, however the page words it. */
const RATING = /(\d(?:\.\d)?)\s*(?:out of\s*5|\/\s*5|★|stars?\b)/i;

/** Text that is a price or a rating and therefore is not the item's name. */
function isValue(line: string): boolean {
  return PRICE.test(line) || RATING.test(line);
}

function priceIn(lines: string[]): string | undefined {
  for (const line of lines) {
    const match = PRICE.exec(line);
    if (match) return match[0].replace(/\s+/g, ' ').trim();
  }
  return undefined;
}

function ratingIn(lines: string[]): string | undefined {
  for (const line of lines) {
    const match = RATING.exec(line);
    if (match) return match[1];
  }
  return undefined;
}

/**
 * The item's name.
 *
 * The structure's own answer when it gave one -- a heading or the item's link
 * is what the page itself considers the title. Failing that, the longest line
 * that is not a price or a rating, because on a card without a heading the
 * title is reliably the longest piece of prose in it.
 */
function nameIn(item: ListItem): string | undefined {
  // Any length, when the structure named it: the page said this is the heading
  // or the link, and a product genuinely called "TV" is not a parse error. The
  // length floor below is for the guess, which needs one.
  const titled = item.title?.trim();
  if (titled) return titled;
  const candidates = item.lines.filter((line) => line.length >= 3 && !isValue(line));
  if (candidates.length === 0) return undefined;
  return candidates.reduce((best, line) => (line.length > best.length ? line : best));
}

/** How much of a column has to be filled in before it is worth a column. */
const FILL = 0.5;
/** Fewer than this is not a list; it is a coincidence. */
const MIN_ITEMS = 3;
const MAX_ROWS = 200;
const MAX_CELL = 200;

function clip(value: string): string {
  return value.length > MAX_CELL ? `${value.slice(0, MAX_CELL - 1)}…` : value;
}

/**
 * A table, or nothing.
 *
 * Nothing whenever the result would not be worth the model reading: too few
 * items, no names, or a single column -- a list of names with no other field is
 * something `read_page` already reports better, as controls with handles the
 * agent can act on.
 */
export function tableFromList(items: ListItem[], label?: string): TableSummary | undefined {
  if (items.length < MIN_ITEMS) return undefined;

  const rows = items.slice(0, MAX_ROWS).map((item) => ({
    name: nameIn(item),
    price: priceIn(item.lines),
    rating: ratingIn(item.lines),
    link: item.href,
  }));

  const filled = (pick: (row: (typeof rows)[number]) => string | undefined) =>
    rows.filter((row) => pick(row)?.trim()).length / rows.length;

  if (filled((row) => row.name) < FILL) return undefined;

  const columns: { header: string; pick: (row: (typeof rows)[number]) => string | undefined }[] = [
    { header: 'Name', pick: (row) => row.name },
  ];
  if (filled((row) => row.price) >= FILL) columns.push({ header: 'Price', pick: (row) => row.price });
  if (filled((row) => row.rating) >= FILL) {
    columns.push({ header: 'Rating', pick: (row) => row.rating });
  }
  if (filled((row) => row.link) >= FILL) columns.push({ header: 'Link', pick: (row) => row.link });

  // A single column of names is not a table. `read_page` already reports those,
  // as controls carrying handles the agent can act on, which is strictly more
  // useful than the same strings with no way to click them.
  if (columns.length < 2) return undefined;

  const body = rows
    .map((row) => columns.map((column) => clip(column.pick(row)?.trim() ?? '')))
    // A row with no name is a divider, an advert slot, or a "load more" tile.
    .filter((cells) => cells[0]);

  if (body.length < MIN_ITEMS) return undefined;

  return {
    label,
    rows: body.length,
    columns: columns.length,
    headers: columns.map((column) => column.header),
    sample: body.slice(0, 5),
    body,
  };
}
