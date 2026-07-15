import { describe, expect, it } from 'vitest';
import { parseSkillFile } from '../src/skills.js';

describe('parseSkillFile', () => {
  it('parses name and description from frontmatter', () => {
    const content =
      '---\nname: pdf-processing\ndescription: Extract text from PDFs. Use when working with PDF files.\n---\n\n# PDF processing\n\nUse pdfplumber.';
    const parsed = parseSkillFile(content);
    expect(parsed.name).toBe('pdf-processing');
    expect(parsed.description).toBe('Extract text from PDFs. Use when working with PDF files.');
    expect(parsed.body).toBe('# PDF processing\n\nUse pdfplumber.');
  });

  it('unquotes quoted scalar values', () => {
    const content = '---\nname: "my-skill"\ndescription: \'Does a thing\'\n---\nBody';
    const parsed = parseSkillFile(content);
    expect(parsed.name).toBe('my-skill');
    expect(parsed.description).toBe('Does a thing');
  });

  it('returns undefined name/description when there is no frontmatter', () => {
    const parsed = parseSkillFile('# Just a doc\n\nNo frontmatter here.');
    expect(parsed.name).toBeUndefined();
    expect(parsed.description).toBeUndefined();
    expect(parsed.body).toBe('# Just a doc\n\nNo frontmatter here.');
  });

  it('returns undefined name/description when frontmatter omits them', () => {
    const parsed = parseSkillFile('---\nlicense: MIT\n---\nBody');
    expect(parsed.name).toBeUndefined();
    expect(parsed.description).toBeUndefined();
    expect(parsed.body).toBe('Body');
  });
});
