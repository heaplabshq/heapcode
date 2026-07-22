/**
 * Default directories excluded from search, indexing, the repo map, and
 * @-mentions — dependency/build/cache output that's rarely worth the agent's
 * or the RAG index's attention, and often huge enough (a Python venv can be
 * tens of thousands of files) to make either painfully slow if not skipped.
 * Project-specific extras layer on top via `.heapcodeignore`, not by editing
 * this list.
 */
export const DEFAULT_IGNORE_DIRS = [
  // VCS / heapcode's own state
  '.git',
  '.heapcode',
  // JS/TS
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  'coverage',
  // Python
  'venv',
  '.venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.tox',
  // Rust / Java / Go / Ruby et al.
  'target',
  'vendor',
];

/** A `vscode.workspace.findFiles`-style exclude glob covering every default ignore directory, at any depth. */
export const DEFAULT_IGNORE_GLOB = `**/{${DEFAULT_IGNORE_DIRS.join(',')}}/**`;
