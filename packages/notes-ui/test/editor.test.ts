import { EditorSelection, EditorState, type StateCommand } from '@codemirror/state';
import { parser as baseParser, GFM } from '@lezer/markdown';
import { describe, expect, it } from 'vitest';
import { insertWikiLink, setLineKind, toggleInline, toggleTask } from '../src/editor/commands.js';
import { imageSrc } from '../src/editor/live.js';
import { heapnotesMarkdown, wikiTarget } from '../src/editor/markup.js';
import { fuzzyFilter } from '../src/fuzzy.js';

function run(
  cmd: StateCommand,
  doc: string,
  from: number,
  to = from,
): { doc: string; sel: [number, number] } {
  let state = EditorState.create({ doc, selection: EditorSelection.range(from, to) });
  cmd({ state, dispatch: (tr) => (state = tr.state) });
  return { doc: state.doc.toString(), sel: [state.selection.main.from, state.selection.main.to] };
}

describe('formatting commands', () => {
  it('wraps a selection and unwraps it again', () => {
    const on = run(toggleInline('**'), 'a word b', 2, 6);
    expect(on).toEqual({ doc: 'a **word** b', sel: [4, 8] });
    expect(run(toggleInline('**'), on.doc, ...on.sel).doc).toBe('a word b');
  });

  it('puts the cursor between markers when nothing is selected', () => {
    expect(run(toggleInline('=='), 'ab', 1)).toEqual({ doc: 'a====b', sel: [3, 3] });
  });

  it('turns a line into a heading, replacing a list mark, and back', () => {
    expect(run(setLineKind({ kind: 'heading', level: 2 }), '- item', 3).doc).toBe('## item');
    expect(run(setLineKind({ kind: 'heading', level: 2 }), '## item', 3).doc).toBe('item');
  });

  it('numbers an ordered list across the selected lines', () => {
    expect(run(setLineKind({ kind: 'ordered' }), 'a\nb\nc', 0, 5).doc).toBe('1. a\n2. b\n3. c');
  });

  it('ticks a task, unticks it, and makes a plain line one', () => {
    expect(run(toggleTask, '- [ ] milk', 7).doc).toBe('- [x] milk');
    expect(run(toggleTask, '- [x] milk', 7).doc).toBe('- [ ] milk');
    expect(run(toggleTask, 'milk', 0).doc).toBe('- [ ] milk');
    expect(run(toggleTask, '- milk', 0).doc).toBe('- [ ] milk');
  });

  it('makes a wiki link of the selection', () => {
    expect(run(insertWikiLink, 'see Plan here', 4, 8)).toEqual({
      doc: 'see [[Plan]] here',
      sel: [12, 12],
    });
  });
});

describe('the grammar', () => {
  const parser = baseParser.configure([GFM, ...heapnotesMarkdown]);
  const names = (doc: string) => {
    const out: string[] = [];
    parser.parse(doc).iterate({ enter: (n) => void out.push(n.name) });
    return out;
  };

  it('knows Bear’s inline extras', () => {
    const n = names('==hi== ~u~ ~~s~~ #tag #multi word# [[Note|alias]] ![[pic.png]]');
    for (const name of ['Highlight', 'Underline', 'Strikethrough', 'Hashtag', 'WikiLink'])
      expect(n).toContain(name);
    expect(n.filter((x) => x === 'Hashtag')).toHaveLength(2);
    expect(n.filter((x) => x === 'WikiLink')).toHaveLength(2);
  });

  it('has no setext headings or indented code', () => {
    expect(names('Title\n===\n')).not.toContain('SetextHeading1');
    expect(names('para\n\n    not code\n')).not.toContain('CodeBlock');
  });

  it('reads the target out of a wiki link', () => {
    expect(wikiTarget('[[Note#Part|shown]]')).toBe('Note');
    expect(wikiTarget('![[pic.png]]')).toBe('pic.png');
  });
});

describe('image sources', () => {
  const ctx = { dir: 'trips/japan', attachmentBase: '/notes/attachment/' };
  it('resolves vault files relative to the note', () => {
    expect(imageSrc('assets/my%20pic.png', ctx)).toBe(
      '/notes/attachment/trips/japan/assets/my%20pic.png',
    );
    expect(imageSrc('../shared/x.png', ctx)).toBe('/notes/attachment/trips/shared/x.png');
  });
  it('allows https, refuses escapes and other schemes', () => {
    expect(imageSrc('https://e.com/a.png', ctx)).toBe('https://e.com/a.png');
    expect(imageSrc('../../../x.png', ctx)).toBeNull();
    expect(imageSrc('file:///etc/passwd', ctx)).toBeNull();
    expect(imageSrc('http://e.com/a.png', ctx)).toBeNull();
  });
});

describe('quick open matching', () => {
  it('puts prefixes first, then word starts, then scattered letters', () => {
    const items = ['Team meeting', 'Meeting notes', 'Some extra things'];
    expect(fuzzyFilter('meet', items, (s) => s)).toEqual([
      'Meeting notes',
      'Team meeting',
      'Some extra things',
    ]);
    expect(fuzzyFilter('not', ['Another', 'Meeting notes'], (s) => s)).toEqual([
      'Meeting notes',
      'Another',
    ]);
    expect(fuzzyFilter('xyz', items, (s) => s)).toEqual([]);
  });
});

describe('the Apply card diff', () => {
  it('marks added and removed lines and folds long unchanged runs', async () => {
    const { lineDiff } = await import('../src/diff.js');
    const before = ['# T', 'a', 'b', 'c', 'd', 'e', 'f', 'old'].join('\n');
    const after = ['# T', 'a', 'b', 'c', 'd', 'e', 'f', 'new', 'more'].join('\n');
    expect(lineDiff(before, after, 1)).toEqual([
      { kind: 'fold', count: 6 },
      { kind: 'same', text: 'f' },
      { kind: 'del', text: 'old' },
      { kind: 'add', text: 'new' },
      { kind: 'add', text: 'more' },
    ]);
    expect(lineDiff('', 'x\n')).toEqual([{ kind: 'add', text: 'x' }]);
  });
});

describe('what ⌘J works on', () => {
  it('is the selection, the paragraph around the cursor, and never the title', async () => {
    const { targetRange } = await import('../src/editor/aiTarget.js');
    const doc = '# Title\nfirst para\nstill first\n\nsecond';
    const at = (anchor: number, head = anchor) =>
      targetRange(EditorState.create({ doc, selection: EditorSelection.range(anchor, head) }));
    const slice = (r?: { from: number; to: number }) => (r ? doc.slice(r.from, r.to) : undefined);
    expect(slice(at(10))).toBe('first para\nstill first');
    expect(slice(at(doc.length - 2))).toBe('second');
    expect(at(3)).toBeUndefined();
    expect(slice(at(2, 14))).toBe('first ');
    expect(at(doc.indexOf('\n\n') + 1)).toBeUndefined();
  });
});
