/**
 * Unified-diff-style text between two versions of a file, for showing an
 * edit's actual effect (not just "Edited path."). Trims the common
 * prefix/suffix and treats everything between as one changed block — not a
 * minimal (LCS) diff, so an edit that changes one word in the middle of a
 * long unchanged block still shows the whole block as removed+added. That's
 * the right tradeoff here: edit_file/multi_edit already know the change is
 * one contiguous region (a search/replace, or an apply-model merge), so a
 * cheap O(n) trim is exact enough without pulling in a real diff algorithm.
 */
export function unifiedDiff(oldText: string, newText: string, context = 2): string {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');

  const maxCommon = Math.min(oldLines.length, newLines.length);
  let prefix = 0;
  while (prefix < maxCommon && oldLines[prefix] === newLines[prefix]) prefix++;

  let suffix = 0;
  const maxSuffix = maxCommon - prefix;
  while (suffix < maxSuffix && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) suffix++;

  if (prefix === oldLines.length && prefix === newLines.length) return '';

  const oldChangedEnd = oldLines.length - suffix;
  const newChangedEnd = newLines.length - suffix;
  const start = Math.max(0, prefix - context);
  const oldEnd = Math.min(oldLines.length, oldChangedEnd + context);
  const newEnd = Math.min(newLines.length, newChangedEnd + context);

  const lines: string[] = [`@@ -${start + 1},${oldEnd - start} +${start + 1},${newEnd - start} @@`];
  for (let i = start; i < prefix; i++) lines.push(` ${oldLines[i]}`);
  for (let i = prefix; i < oldChangedEnd; i++) lines.push(`-${oldLines[i]}`);
  for (let i = prefix; i < newChangedEnd; i++) lines.push(`+${newLines[i]}`);
  for (let i = newChangedEnd; i < newEnd; i++) lines.push(` ${newLines[i]}`);
  return lines.join('\n');
}
