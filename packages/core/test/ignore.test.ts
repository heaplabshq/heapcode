import { describe, expect, it } from 'vitest';
import { DEFAULT_IGNORE_DIRS, DEFAULT_IGNORE_GLOB } from '../src/config/ignore.js';

describe('DEFAULT_IGNORE_DIRS / DEFAULT_IGNORE_GLOB', () => {
  it('covers common Python virtual-env and cache directories, not just JS/TS ones', () => {
    for (const dir of ['venv', '.venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox']) {
      expect(DEFAULT_IGNORE_DIRS).toContain(dir);
    }
  });

  it('still covers the existing JS/TS/VCS/other-language directories', () => {
    for (const dir of ['node_modules', 'dist', 'build', 'out', '.next', 'coverage', '.git', '.heapcode', 'target', 'vendor']) {
      expect(DEFAULT_IGNORE_DIRS).toContain(dir);
    }
  });

  it('the glob is a single brace-group matching every default dir at any depth', () => {
    expect(DEFAULT_IGNORE_GLOB).toBe(`**/{${DEFAULT_IGNORE_DIRS.join(',')}}/**`);
    for (const dir of DEFAULT_IGNORE_DIRS) {
      expect(DEFAULT_IGNORE_GLOB).toContain(dir);
    }
  });
});
