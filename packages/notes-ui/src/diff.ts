/**
 * Lines added, removed and kept between two texts — the Apply card's diff.
 * Plain LCS over lines: notes are short, and a readable diff of a few hundred
 * lines is the whole requirement. Long unchanged runs fold to a count.
 */
export type DiffLine =
  { kind: 'same' | 'add' | 'del'; text: string } | { kind: 'fold'; count: number };

export function lineDiff(before: string, after: string, context = 2): DiffLine[] {
  const a = before.replace(/\n$/, '').split('\n');
  const b = after.replace(/\n$/, '').split('\n');
  if (before === '') a.length = 0;
  const n = a.length;
  const m = b.length;
  // lcs[i][j]: common lines in a[i..], b[j..].
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i]![j] =
        a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);

  const raw: { kind: 'same' | 'add' | 'del'; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      raw.push({ kind: 'same', text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) raw.push({ kind: 'del', text: a[i++]! });
    else raw.push({ kind: 'add', text: b[j++]! });
  }
  while (i < n) raw.push({ kind: 'del', text: a[i++]! });
  while (j < m) raw.push({ kind: 'add', text: b[j++]! });

  // Keep `context` unchanged lines around each change; fold the rest.
  const keep = raw.map(() => false);
  raw.forEach((l, k) => {
    if (l.kind === 'same') return;
    for (let d = -context; d <= context; d++) if (raw[k + d]) keep[k + d] = true;
  });
  const out: DiffLine[] = [];
  let folded = 0;
  raw.forEach((l, k) => {
    if (keep[k] || l.kind !== 'same') {
      if (folded) out.push({ kind: 'fold', count: folded });
      folded = 0;
      out.push(l);
    } else folded++;
  });
  if (folded) out.push({ kind: 'fold', count: folded });
  return out;
}
