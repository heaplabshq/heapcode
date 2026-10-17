import { describe, expect, it } from 'vitest';
import {
  findTags,
  parseNote,
  readFrontMatter,
  updateFrontMatter,
  findSection,
  outline,
  parseQuery,
} from '../src/index.js';

describe('front matter', () => {
  it('reads keys and where the body starts', () => {
    const text = '---\nid: ABC\npinned: true\n---\n# Title\n';
    const fm = readFrontMatter(text);
    expect(fm.data).toEqual({ id: 'ABC', pinned: true });
    expect(text.slice(fm.end)).toBe('# Title\n');
  });

  it('keeps other keys, order and comments when it changes one', () => {
    const text = '---\n# mine\naliases: [a]\nid: ABC\n---\nBody\n';
    expect(updateFrontMatter(text, { pinned: true })).toBe(
      '---\n# mine\naliases: [ a ]\nid: ABC\npinned: true\n---\nBody\n',
    );
  });

  it('adds a block when there was none and drops it when it empties', () => {
    const added = updateFrontMatter('Body\n', { pinned: true });
    expect(added).toBe('---\npinned: true\n---\nBody\n');
    expect(updateFrontMatter(added, { pinned: undefined })).toBe('Body\n');
  });

  it('refuses to rewrite broken YAML', () => {
    expect(() => updateFrontMatter('---\n: : bad\n  - x\n---\nBody', { pinned: true })).toThrow(
      /isn't valid YAML/,
    );
  });

  it('is not front matter unless the very first line is ---', () => {
    expect(readFrontMatter('\n---\na: 1\n---\n').present).toBe(false);
  });
});

describe('parseNote', () => {
  it('takes the title from the first line and a preview from what follows', () => {
    const p = parseNote(
      '---\nid: X\n---\n\n# My **bold** note\n\nSome *lead* text\nand more.\n\n## Next\n',
    );
    expect(p.title).toBe('My bold note');
    expect(p.subtitle).toBe('Some lead text and more.');
  });

  it('keeps underscores inside words in the title', () => {
    expect(parseNote('snake_case_name\n').title).toBe('snake_case_name');
  });

  it('finds Bear tags in all three forms', () => {
    const p = parseNote('# T\n#work #parent/child and #multi word tag# here\n');
    expect(p.tags.map((t) => t.name)).toEqual(['work', 'parent/child', 'multi word tag']);
  });

  it('does not take headings, URL fragments, numbers or code as tags', () => {
    const p = parseNote(
      '# Heading\n## Sub\nSee https://x.com/#frag and issue #12 and a#b\n`#notatag`\n```\n#nope\n```\n',
    );
    expect(p.tags).toEqual([]);
  });

  it('trims trailing punctuation off a tag', () => {
    expect(findTags('Done for #today.').map((t) => t.name)).toEqual(['today']);
  });

  it('gives every tag its exact span', () => {
    const text = 'x #a/b y';
    const [t] = parseNote(text).tags;
    expect(text.slice(t!.start, t!.end)).toBe('#a/b');
  });

  it('parses wiki links with aliases and headings', () => {
    const p = parseNote('[[Plain]] [[Target|shown]] [[Note#Part]] ![[pic.png]]\n');
    expect(
      p.wikiLinks.map(({ target, heading, alias, embed }) => ({ target, heading, alias, embed })),
    ).toEqual([
      { target: 'Plain', heading: undefined, alias: undefined, embed: false },
      { target: 'Target', heading: undefined, alias: 'shown', embed: false },
      { target: 'Note', heading: 'Part', alias: undefined, embed: false },
      { target: 'pic.png', heading: undefined, alias: undefined, embed: true },
    ]);
    expect(p.hasImages).toBe(true);
  });

  it('counts tasks, and sees code and local files', () => {
    const p = parseNote(
      '- [ ] one\n- [x] two\n* [X] three\n1. [ ] four\n[spec](assets/spec%20v2.pdf) ![](assets/a.png) [web](https://x.com)\nuse `x`\n',
    );
    expect([p.todoOpen, p.todoDone]).toEqual([2, 2]);
    expect(p.localLinks.map((l) => [l.path, l.image])).toEqual([
      ['assets/spec v2.pdf', false],
      ['assets/a.png', true],
    ]);
    expect([p.hasFiles, p.hasImages, p.hasCode]).toEqual([true, true, true]);
  });

  it('has no setext headings or indented code (Bear turns both off)', () => {
    const p = parseNote('Title\n===\n\n    #indented tag\n');
    expect(p.headings).toEqual([]);
    expect(p.tags.map((t) => t.name)).toEqual(['indented']);
  });

  it('ignores headings inside a fenced block, even an unclosed one', () => {
    const p = parseNote('# A\n~~~\n# not a heading\n');
    expect(p.headings.map((h) => h.text)).toEqual(['A']);
  });
});

describe('sections', () => {
  const text = '# Title\nlead\n## Setup\ns\n### Install\ni\n## Use\nu\n### Install\nj\n';
  const parsed = parseNote(text);

  it('outlines with unique addresses', () => {
    expect(outline(text, parsed).map((s) => s.address)).toEqual([
      '# Title',
      '# Title\n## Setup',
      '# Title\n## Setup\n### Install',
      '# Title\n## Use',
      '# Title\n## Use\n### Install',
    ]);
  });

  it('resolves a nested address to its range', () => {
    const s = findSection(text, parsed, '## Setup\n### Install');
    expect(text.slice(s.start, s.end)).toBe('### Install\ni\n');
  });

  it('refuses an ambiguous address and takes an index', () => {
    expect(() => findSection(text, parsed, 'Install')).toThrow(/2 sections match/);
    const s = findSection(text, parsed, 'Install\n[2]');
    expect(text.slice(s.start, s.end)).toBe('### Install\nj\n');
  });

  it('a section runs until a heading of the same or higher level', () => {
    const s = findSection(text, parsed, '## Setup');
    expect(text.slice(s.start, s.end)).toBe('## Setup\ns\n### Install\ni\n');
  });

  it('preamble is the lead text after the title line', () => {
    const s = findSection(text, parsed, 'preamble');
    expect(text.slice(s.start, s.end)).toBe('lead\n');
  });
});

describe('parseQuery', () => {
  const now = new Date(2026, 9, 18, 15, 0, 0);

  it('splits words, phrases, exclusions, tags and tokens', () => {
    const q = parseQuery(
      'meeting "next steps" -draft #work -#work/old #multi word# @todo -@pinned @title',
      now,
    );
    expect(q.terms).toEqual([
      { text: 'meeting', phrase: false },
      { text: 'next steps', phrase: true },
    ]);
    expect(q.excludeTerms).toEqual([{ text: 'draft', phrase: false }]);
    expect(q.tags).toEqual(['work', 'multi word']);
    expect(q.excludeTags).toEqual(['work/old']);
    expect(q.titleOnly).toBe(true);
    expect(q.filters).toEqual([
      { kind: 'flag', flag: 'todo', negate: false },
      { kind: 'flag', flag: 'pinned', negate: true },
    ]);
  });

  it('turns date tokens into local-day ranges', () => {
    const today = new Date(2026, 9, 18).getTime();
    const tomorrow = new Date(2026, 9, 19).getTime();
    expect(parseQuery('@today', now).filters[0]).toEqual({
      kind: 'date',
      field: 'modified',
      from: today,
      to: tomorrow,
      negate: false,
    });
    expect(parseQuery('@last7days', now).filters[0]).toMatchObject({
      field: 'modified',
      from: new Date(2026, 9, 12).getTime(),
    });
    expect(parseQuery('@cdate(<2026-01-02)', now).filters[0]).toMatchObject({
      field: 'created',
      to: new Date(2026, 0, 2).getTime(),
    });
    expect(parseQuery('@created30days', now).filters[0]).toMatchObject({ field: 'created' });
  });

  it('names the tokens it knows when given one it does not', () => {
    expect(() => parseQuery('@soon', now)).toThrow(/Unknown search token @soon/);
  });
});

describe('preview', () => {
  it('skips the tag line under the title', () => {
    expect(parseNote('# T\n#a #b c#\n\nReal text\n').subtitle).toBe('Real text');
  });
});

describe('preview of a list', () => {
  it('strips the list and task marks from every lead line', () => {
    expect(parseNote('# T\n- [ ] milk\n- [x] eggs\n').subtitle).toBe('milk eggs');
  });
});
