import { useEffect, useState } from 'react';

/**
 * How long ago, as a glance: "just now", "12m ago", "3h ago", "3d 2h ago";
 * past a week, the date — "3d 2h" stops meaning much after that.
 */
export function ago(iso: string, now = new Date()): string {
  const then = new Date(iso);
  const mins = Math.floor((now.getTime() - then.getTime()) / 60_000);
  if (Number.isNaN(mins)) return '';
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return hours % 24 ? `${days}d ${hours % 24}h ago` : `${days}d ago`;
  return then.toLocaleDateString(
    undefined,
    then.getFullYear() === now.getFullYear()
      ? { month: 'short', day: 'numeric' }
      : { dateStyle: 'medium' },
  );
}

/** "18 Oct 2026, 18:28" — the exact moment, for Info and tooltips. */
export function fullDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** The time, re-read every `ms` so "3m ago" doesn't stay 3m. */
export function useNow(ms = 60_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/**
 * What a note's `source` means, in words. None for a note without one: it was
 * written here — or made before sources were kept, or by another editor — so
 * saying "written here" could be wrong.
 */
export function sourceLabel(source: string | undefined): string | undefined {
  switch (source) {
    case undefined:
    case '':
      return undefined;
    case 'bear':
      return 'Imported from Bear';
    case 'obsidian':
      return 'Imported from Obsidian';
    case 'markdown':
      return 'Imported from a folder';
    case 'ask':
      return 'Created by Ask';
    case 'mcp':
      return 'Created by an AI app (MCP)';
    case 'terminal':
      return 'Created in the terminal';
    default:
      return source;
  }
}
