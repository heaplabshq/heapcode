import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { highlight } from 'cli-highlight';
import { languageForPath } from './codeLanguage.js';
import type { TranscriptItem } from './types.js';

// A preview, not a pager — enough to actually see what the tool returned
// (file contents, command output) without one big result taking over the
// transcript. Squashing everything to one line (the old behavior) threw
// away real information: a read_file result became unreadable, and a
// run_command's actual output vanished into "npm test 2>&1 | ...".
const SUMMARY_CHARS = 800;
const SUMMARY_LINES = 16;

/** Matches a file-path header at the start of a line — search()'s "src/foo.ts:12:" and
 * RagIndexer.queryFormatted()'s "--- src/foo.ts:10-20 (score 0.87) ---", nothing else
 * (log/stack-trace lines don't start with a bare path, so this doesn't false-positive on them). */
const BLOCK_HEADER_RE = /^-{0,3}\s*([^\s:]+\.[A-Za-z0-9]+):\d/;

/** Best-effort: cli-highlight throws on some inputs/unsupported languages — never let a render crash on that. */
function highlightSafe(text: string, language: string): string {
  try {
    return highlight(text, { language, ignoreIllegals: true });
  } catch {
    return text;
  }
}

/**
 * search/semantic_search results interleave snippets from several files, each
 * potentially a different language, in one result string — a single
 * `language` (like read_file gets) doesn't fit. Instead this splits on each
 * file-path header line and highlights every block with the language its own
 * header implies, so e.g. a Python hit and a TS hit in the same result each
 * render correctly. Text with no header at all (run_command output, "No
 * matches.") passes through completely unchanged.
 */
export function highlightPerBlock(text: string): { body: string; highlighted: boolean } {
  const lines = text.split('\n');
  const out: string[] = [];
  let start = 0;
  let lang: string | undefined;
  let highlighted = false;
  const flush = (end: number): void => {
    const chunk = lines.slice(start, end).join('\n');
    out.push(lang ? highlightSafe(chunk, lang) : chunk);
    if (lang) highlighted = true;
  };
  for (let i = 0; i < lines.length; i++) {
    const match = BLOCK_HEADER_RE.exec(lines[i]!);
    if (match) {
      if (i > start) flush(i);
      start = i;
      lang = languageForPath(match[1]);
    }
  }
  flush(lines.length);
  return { body: out.join('\n'), highlighted };
}

export function ToolChip({ item }: { item: Extract<TranscriptItem, { kind: 'tool' }> }): React.ReactElement {
  const icon =
    item.status === 'running' ? (
      <Text color="cyan">
        <Spinner type="dots" />
      </Text>
    ) : item.status === 'ok' ? (
      <Text color="green">✓</Text>
    ) : (
      <Text color="red">✗</Text>
    );
  const indent = item.indent ? 2 : 0;

  let summaryNode: React.ReactNode = null;
  if (item.summary && item.status !== 'running') {
    const lines = item.summary.slice(0, SUMMARY_CHARS).split('\n');
    const shown = lines.slice(0, SUMMARY_LINES);
    const omitted = lines.length - shown.length;
    const text = shown.join('\n');
    const { body, highlighted } = item.language ? { body: highlightSafe(text, item.language), highlighted: true } : highlightPerBlock(text);
    summaryNode = (
      <Box flexDirection="column">
        <Text dimColor={!highlighted}>{body}</Text>
        {omitted > 0 && <Text dimColor>… {omitted} more line(s)</Text>}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginBottom={item.status === 'running' ? 0 : 1} marginLeft={indent}>
      <Box gap={1}>
        {item.indent && <Text dimColor>↳</Text>}
        {icon}
        <Text dimColor>{item.description}</Text>
      </Box>
      {summaryNode && <Box marginLeft={2}>{summaryNode}</Box>}
    </Box>
  );
}
