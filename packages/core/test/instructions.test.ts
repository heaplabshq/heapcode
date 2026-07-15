import { describe, expect, it } from 'vitest';
import { matchGlob, matchesAnyGlob, parseInstructionFile } from '../src/instructions.js';

describe('parseInstructionFile', () => {
  it('defaults to applying everywhere when there is no front matter', () => {
    const { applyTo, body } = parseInstructionFile('Just some instructions.');
    expect(applyTo).toEqual(['**']);
    expect(body).toBe('Just some instructions.');
  });

  it('reads a single applyTo glob from front matter', () => {
    const { applyTo, body } = parseInstructionFile(
      '---\napplyTo: "**/*.tsx"\n---\nUse function components.',
    );
    expect(applyTo).toEqual(['**/*.tsx']);
    expect(body).toBe('Use function components.');
  });

  it('reads comma-separated globs', () => {
    const { applyTo } = parseInstructionFile('---\napplyTo: "*.ts, *.tsx"\n---\nBody');
    expect(applyTo).toEqual(['*.ts', '*.tsx']);
  });

  it('defaults to applying everywhere when front matter has no applyTo key', () => {
    const { applyTo } = parseInstructionFile('---\ntitle: notes\n---\nBody');
    expect(applyTo).toEqual(['**']);
  });
});

describe('matchGlob', () => {
  it('matches a simple extension glob', () => {
    expect(matchGlob('*.md', 'README.md')).toBe(true);
    expect(matchGlob('*.md', 'src/README.md')).toBe(false);
  });

  it('matches ** across directories', () => {
    expect(matchGlob('**/*.tsx', 'packages/webview-ui/src/App.tsx')).toBe(true);
    expect(matchGlob('**/*.tsx', 'App.tsx')).toBe(true);
    expect(matchGlob('**/*.tsx', 'App.ts')).toBe(false);
  });

  it('matches a directory prefix glob', () => {
    expect(matchGlob('src/**', 'src/foo/bar.ts')).toBe(true);
    expect(matchGlob('src/**', 'lib/foo/bar.ts')).toBe(false);
  });

  it('always matches the ** wildcard', () => {
    expect(matchGlob('**', 'anything/at/all.ts')).toBe(true);
  });
});

describe('matchesAnyGlob', () => {
  it('matches if any pattern matches', () => {
    expect(matchesAnyGlob(['*.ts', '*.tsx'], 'App.tsx')).toBe(true);
    expect(matchesAnyGlob(['*.ts', '*.tsx'], 'App.css')).toBe(false);
  });
});
