import type { ToolDefinition } from './tools.js';

/**
 * The tool schemas both hosts offer, keyed by name.
 *
 * A record rather than an array on purpose: the two hosts present these in
 * the same relative order but interleave their own extras (the extension's
 * language-server tools, its delegate_task), and the order tools are offered
 * in is part of the prompt. Each host composes its own ordered list from
 * these, so neither's ordering changes as a side effect of sharing them.
 *
 * get_symbols is not here — its description names the mechanism behind it,
 * which genuinely differs (tree-sitter in the CLI, the language server in the
 * extension). See getSymbolsTool.
 */
export const sharedAgentTools = {
  read_file: {
    name: 'read_file',
    description:
      'Read a file (or a line range of it). Returns content with line numbers. ' +
      'For files over ~300 lines, calling this with no range first returns a symbol outline ' +
      'instead of the full text — call again with start_line/end_line for the section you need, ' +
      'or repeat the unranged call to force the full contents.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative path' },
        start_line: { type: 'number', description: 'Optional 1-based first line' },
        end_line: { type: 'number', description: 'Optional 1-based last line (inclusive)' },
      },
      required: ['path'],
    },
    permission: 'read',
  },
  list_dir: {
    name: 'list_dir',
    description: 'List files and directories at a workspace-relative path (non-recursive).',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Workspace-relative path, "." for root' } },
      required: ['path'],
    },
    permission: 'read',
  },
  search: {
    name: 'search',
    description: 'Search file contents with a regex. Returns file:line matches.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression' },
        glob: { type: 'string', description: 'Optional file glob, e.g. "**/*.ts"' },
      },
      required: ['pattern'],
    },
    permission: 'read',
  },
  write_file: {
    name: 'write_file',
    description: 'Create or overwrite a file with the given content.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
    permission: 'write',
  },
  edit_file: {
    name: 'edit_file',
    description:
      'Replace an exact section of a file. "search" must match existing content (whitespace-tolerant); provide enough surrounding lines to be unique.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        search: { type: 'string', description: 'Existing code to replace' },
        replace: { type: 'string', description: 'New code' },
      },
      required: ['path', 'search', 'replace'],
    },
    permission: 'write',
  },
  rename_file: {
    name: 'rename_file',
    description: 'Rename or move a file.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, newPath: { type: 'string' } },
      required: ['path', 'newPath'],
    },
    permission: 'write',
  },
  delete_file: {
    name: 'delete_file',
    description: 'Delete a file.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    permission: 'destructive',
  },
  semantic_search: {
    name: 'semantic_search',
    description:
      'Search the codebase by meaning (embeddings), e.g. "where is authentication handled". Falls back to text search when no index exists.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Natural-language query' } },
      required: ['query'],
    },
    permission: 'read',
  },
  repo_map: {
    name: 'repo_map',
    description:
      'Get an outline of the workspace: every file and its top-level symbols (functions, classes, methods) with line numbers — no code bodies. Use it to orient before searching, e.g. to check whether something already exists before writing it.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Optional path prefix to scope the map to a directory or file (e.g. "packages/core/src/rag"). Omit for the whole workspace.',
        },
      },
    },
    permission: 'read',
  },
  run_command: {
    name: 'run_command',
    description:
      'Run a shell command (npm/pnpm/git/etc). Returns stdout, stderr, and exit code. ' +
      'The working directory persists between calls (cd carries over); it starts at the workspace root. ' +
      'Prefer run_tests for the project\'s test suite. Package installs are checked against the ' +
      'registry first and blocked if the package name looks hallucinated.',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    permission: 'execute',
  },
  run_tests: {
    name: 'run_tests',
    description:
      'Run the project\'s test command (e.g. "npm test", "pytest", "cargo test", "go test ./...") ' +
      'and report pass/fail from the exit code. Use this — not run_command — to verify changes before finishing.',
    parameters: { type: 'object', properties: { command: { type: 'string', description: 'The test command to run' } }, required: ['command'] },
    permission: 'execute',
    verifies: true,
  },
  check_package_exists: {
    name: 'check_package_exists',
    description:
      'Check whether a package name actually exists on npm or PyPI before adding it as a dependency — ' +
      'catches hallucinated package names before they\'re installed.',
    parameters: {
      type: 'object',
      properties: { registry: { type: 'string', enum: ['npm', 'pypi'] }, name: { type: 'string' } },
      required: ['registry', 'name'],
    },
    permission: 'execute',
  },
  fetch_url: {
    name: 'fetch_url',
    description: 'Fetch a web page or API over HTTP(S) — documentation, READMEs, API responses. HTML is reduced to readable text.',
    parameters: { type: 'object', properties: { url: { type: 'string', description: 'http(s):// URL' } }, required: ['url'] },
    permission: 'execute',
    // Arbitrary third-party content — same injection posture as MCP (PLAN.md M7).
    untrustedOutput: true,
  },
  multi_edit: {
    name: 'multi_edit',
    description: 'Apply several search/replace edits to one file atomically (all succeed or none are written). Same matching rules as edit_file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: { search: { type: 'string', description: 'Existing code to replace' }, replace: { type: 'string', description: 'New code' } },
            required: ['search', 'replace'],
          },
        },
      },
      required: ['path', 'edits'],
    },
    permission: 'write',
  },
  create_directory: {
    name: 'create_directory',
    description: 'Create a directory (and any missing parents).',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    permission: 'write',
  },
  ask_user: {
    name: 'ask_user',
    description:
      'Ask the user a clarifying question when blocked on a decision only they can make (ambiguous requirements, destructive trade-offs). Use sparingly — prefer sensible defaults.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        options: { type: 'array', items: { type: 'string' }, description: 'Optional short answer choices' },
        blocksAction: {
          type: 'boolean',
          description:
            'Set true when this question gates an action you are about to take ("should I delete X?", "may I force-push?") rather than asking which option to use or what was meant. ' +
            'A gating question is never auto-resolved if the user steps away — it waits for a real answer. Omit or set false for a choice or a clarification.',
        },
      },
      required: ['question'],
    },
    permission: 'read',
  },
  list_skills: {
    name: 'list_skills',
    description:
      'List available Skills (name + description) from .claude/skills/ (project) and ~/.claude/skills/ ' +
      '(personal) — the same convention Claude Code itself uses. Skills are model-invoked: call this early, ' +
      'and if one\'s description matches the current task, call load_skill on it before proceeding.',
    parameters: { type: 'object', properties: {} },
    permission: 'read',
  },
  load_skill: {
    name: 'load_skill',
    description:
      'Load a Skill\'s full instructions by name (from list_skills). If the instructions reference a bundled ' +
      'file (e.g. "see FORMS.md"), call this again with that file as `resource` to read it.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Skill name, from list_skills' }, resource: { type: 'string', description: 'Optional: relative path to a file bundled in the skill\'s own folder' } },
      required: ['name'],
    },
    permission: 'read',
  },
} satisfies Record<string, ToolDefinition>;

/**
 * get_symbols, described in terms of whatever actually produces the outline.
 * The CLI extracts symbols with tree-sitter and reports line numbers; the
 * extension asks the language server and reports line ranges. Same tool
 * contract, and the model is told which it is getting.
 */
export function getSymbolsTool(description: string): ToolDefinition {
  return {
    name: 'get_symbols',
    description,
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Workspace-relative path' } },
      required: ['path'],
    },
    permission: 'read',
  };
}
