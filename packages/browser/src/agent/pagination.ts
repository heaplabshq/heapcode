import type { Control } from '../shared/snapshot.js';

/**
 * Finding the next page, which is harder than it sounds.
 *
 * Two routes, and the URL is the better one wherever it exists: a page number in
 * a query string can be incremented exactly, whereas a pagination control has to
 * be found among a row of controls that are mostly *other* page numbers. An
 * agent left to pick from the control list clicks "1" while on page one about as
 * often as it clicks "Next", and then reports progress it did not make.
 *
 * The control is still needed, because plenty of listings paginate without ever
 * changing the address — and infinite-scroll pages have neither, which is why
 * "there is no next page" has to be a real answer rather than a failure.
 */

/** Names that mean "forward one", including the glyphs used instead of words. */
const NEXT_NAME =
  /^\s*(next|next\s*page|more|show\s*more|load\s*more|older|older\s*posts?|›|»|→|>|>>)\s*$/i;

/** Names that contain it rather than being it — "Next page of results". */
const NEXT_CONTAINS = /\bnext\b|\bload\s*more\b|\bshow\s*more\b/i;

/** Words that look like forward motion but leave the list entirely. */
const NOT_PAGINATION = /\b(next\s*(step|question|day|month|week|year)|continue\s*to|checkout)\b/i;

/**
 * The control that advances the list, if the page has one.
 *
 * An exact name wins over a containing one, so a row holding both "Next" and
 * "Next page of results" resolves to the first rather than to whichever came
 * earlier in the tree. Disabled is respected as the signal it is: a greyed-out
 * "Next" is the page saying there is no next page, and clicking it anyway is how
 * a collection loop spins forever on the last page.
 */
export function findNextControl(controls: Control[]): Control | undefined {
  const candidates = controls.filter(
    (control) =>
      (control.role === 'link' || control.role === 'button') &&
      !NOT_PAGINATION.test(`${control.name} ${control.context ?? ''}`),
  );

  const exact = candidates.find((control) => NEXT_NAME.test(control.name));
  if (exact) return exact.disabled ? undefined : exact;

  const contains = candidates.find((control) => NEXT_CONTAINS.test(control.name));
  if (contains) return contains.disabled ? undefined : contains;

  return undefined;
}

/** True when the page has a next control but it is switched off — the last page. */
export function nextIsExhausted(controls: Control[]): boolean {
  return controls.some(
    (control) =>
      (control.role === 'link' || control.role === 'button') &&
      control.disabled === true &&
      (NEXT_NAME.test(control.name) || NEXT_CONTAINS.test(control.name)),
  );
}

/**
 * Query parameters that mean "which page", in the order they should be tried.
 *
 * Offset-style parameters are separated because they step by the page size
 * rather than by one, and incrementing `start` by one produces a page that
 * overlaps the previous one by everything but a single row.
 */
const PAGE_PARAMS = ['page', 'pg', 'p', 'pageNumber', 'page_number', 'pageIndex'];
const OFFSET_PARAMS = ['offset', 'start', 'from', 'skip'];
const SIZE_PARAMS = ['size', 'limit', 'per_page', 'perPage', 'count', 'rows', 'pageSize'];

/**
 * The same URL, one page further on.
 *
 * Only ever an increment of a parameter that is already there. Adding `?page=2`
 * to a URL that never had a page parameter is a guess, and a wrong guess lands
 * on a 404 or, worse, on a page that quietly ignores it and returns page one
 * again — which a collecting agent reads as "no new rows" and gives up on.
 */
export function nextPageUrl(url: string, rowsPerPage?: number): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }

  for (const name of PAGE_PARAMS) {
    const value = parsed.searchParams.get(name);
    if (value === null) continue;
    const current = Number(value);
    if (!Number.isFinite(current)) continue;
    parsed.searchParams.set(name, String(current + 1));
    return parsed.href;
  }

  for (const name of OFFSET_PARAMS) {
    const value = parsed.searchParams.get(name);
    if (value === null) continue;
    const current = Number(value);
    if (!Number.isFinite(current)) continue;

    // The step has to be a page's worth. The page's own size parameter is the
    // authority; the number of rows just extracted is the next best thing.
    const declared = SIZE_PARAMS.map((size) => Number(parsed.searchParams.get(size))).find(
      (size) => Number.isFinite(size) && size > 0,
    );
    const step = declared ?? (rowsPerPage && rowsPerPage > 0 ? rowsPerPage : undefined);
    if (!step) continue;

    parsed.searchParams.set(name, String(current + step));
    return parsed.href;
  }

  return undefined;
}
