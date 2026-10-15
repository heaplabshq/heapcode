// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTranscript } from '../src/useTranscript.js';
import { emptyTranscript, settle } from '../src/transcript.js';
import { renderMarkdown } from '../src/markdown.js';

afterEach(() => vi.useRealTimers());

describe('useTranscript — streamed events in batches', () => {
  it('applies a burst of chunks together, once, in order', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useTranscript(emptyTranscript));
    act(() => {
      for (const w of ['Hel', 'lo ', 'there']) result.current.applyEvent({ type: 'text_delta', text: w });
    });
    expect(result.current.transcript.items).toHaveLength(0); // queued, not yet drawn
    act(() => vi.advanceTimersByTime(20));
    expect(result.current.transcript.items).toMatchObject([{ kind: 'text', text: 'Hello there', streaming: true }]);
  });

  it("applies what is queued before any other change — a run's end never lands before its last chunks", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useTranscript(emptyTranscript));
    act(() => {
      result.current.applyEvent({ type: 'text_delta', text: 'last words' });
      result.current.setTranscript(settle); // the run ended
    });
    expect(result.current.transcript.items).toMatchObject([{ kind: 'text', text: 'last words', streaming: false }]);
    act(() => vi.advanceTimersByTime(20));
    // Nothing reopened afterwards.
    expect(result.current.transcript.items).toMatchObject([{ kind: 'text', streaming: false }]);
  });
});

describe('renderMarkdown — the cost of highlighting', () => {
  const block = (body: string, lang = ''): string => `\`\`\`${lang}\n${body}\n\`\`\``;

  it('does not highlight text still streaming in', () => {
    const html = renderMarkdown(block('const x = 1;', 'ts'), { highlight: false });
    expect(html).not.toContain('hljs-');
    expect(renderMarkdown(block('const x = 1;', 'ts'))).toContain('hljs-');
  });

  it('guesses the language of a small unlabelled block, but not a large one — that cost ~36ms a time', () => {
    expect(renderMarkdown(block('const x = 1;\nfunction f() { return x; }'))).toContain('hljs-');
    const big = Array.from({ length: 200 }, (_, i) => `const v${i} = await load(${i}); // <b>${i}</b>`).join('\n');
    const html = renderMarkdown(block(big));
    expect(html).not.toContain('hljs-');
    // Still escaped — shown as text, never as markup.
    expect(html).toContain('&lt;b&gt;');
  });
});
