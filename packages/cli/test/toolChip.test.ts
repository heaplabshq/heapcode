import { describe, expect, it } from 'vitest';
import { highlightPerBlock } from '../src/ink/ToolChip.js';

describe('highlightPerBlock', () => {
  it('highlights each file-path-headed block using that file\'s own inferred language (search() output shape)', () => {
    const text = ['src/foo.ts:12:', '  10\tconst x = 1;', '> 12\tconst z = x + 1;', '--', 'lib/bar.py:3:', '  2\tdef f():', '> 3\t    return 1'].join(
      '\n',
    );
    const { body, highlighted } = highlightPerBlock(text);
    expect(highlighted).toBe(true);
    // Structure survives — nothing got squashed onto one line.
    expect(body.split('\n').length).toBe(text.split('\n').length);
    expect(body).toContain('src/foo.ts:12:');
    expect(body).toContain('lib/bar.py:3:');
  });

  it('highlights RagIndexer.queryFormatted()\'s "--- path:start-end (score) ---" header shape too', () => {
    const text = '--- src/auth.ts:1-3 (score 0.90) ---\nfunction authenticate() {}';
    const { highlighted } = highlightPerBlock(text);
    expect(highlighted).toBe(true);
  });

  it('leaves header-less text (run_command output, "No matches.") completely unchanged', () => {
    const text = 'PASS src/foo.test.ts\n  ✓ adds numbers\n\nTest Suites: 1 passed';
    const { body, highlighted } = highlightPerBlock(text);
    expect(highlighted).toBe(false);
    expect(body).toBe(text);
  });

  it('an unrecognized extension in a header is left unhighlighted for that block, not thrown on', () => {
    const text = 'notes.xyz:1:\n> 1\tsome text';
    const { body, highlighted } = highlightPerBlock(text);
    expect(highlighted).toBe(false);
    expect(body).toBe(text);
  });
});
