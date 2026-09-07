import type { ToolDefinition } from './tools.js';

/**
 * The tool schemas both hosts offer, keyed by name.
 *
 * A record rather than an array on purpose: the two hosts present these in
 * the same relative order but interleave their own extras (the extension's
 * language-server tools), and the order tools are offered in is part of the
 * prompt. Each host composes its own ordered list from these, so neither's
 * ordering changes as a side effect of sharing them.
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
      'or repeat the unranged call to force the full contents. ' +
      'Read only the part you need: when you know roughly where something is, a range beats the ' +
      'whole file. And do not re-read a file you have just edited to verify the change — edit_file ' +
      'already showed you the changed region, so a re-read spends a turn confirming what you know.',
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
    description:
      'List files and directories at a workspace-relative path (non-recursive). For finding where ' +
      'something lives, repo_map, search or semantic_search get there in one call; use this when you ' +
      'need to know what is actually in a particular directory.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Workspace-relative path, "." for root' } },
      required: ['path'],
    },
    permission: 'read',
  },
  search: {
    name: 'search',
    description:
      'Search file contents with a regex. Returns file:line matches. Cheaper than reading files to ' +
      'find something: prefer this, semantic_search, or get_symbols over opening files to look.',
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
    description:
      'Create a NEW file, or replace an existing one end to end. Overwrites without warning, so to ' +
      'change part of a file that already exists use edit_file or multi_edit — write_file on a file ' +
      'you have not read in full is how unrelated work gets deleted. ' +
      'Before creating a new file, check that one does not already exist for the job (repo_map or ' +
      'search): extending an existing file is nearly always the smaller change, and a second file ' +
      'doing the same thing is a fork future readers have to reconcile.',
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
      'Replace an exact section of a file. "search" must match existing content (whitespace-tolerant); provide enough surrounding lines to be unique. If the intended sites are genuinely identical, set "replace_all" instead of adding context.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        search: { type: 'string', description: 'Existing code to replace' },
        replace: { type: 'string', description: 'New code' },
        replace_all: {
          type: 'boolean',
          description: 'Replace every occurrence rather than requiring "search" to be unique. Default false.',
        },
      },
      required: ['path', 'search', 'replace'],
    },
    permission: 'write',
  },
  rename_file: {
    name: 'rename_file',
    description:
      'Rename or move a file, keeping its contents. References to it elsewhere are not updated — ' +
      'search for the old path afterwards.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, newPath: { type: 'string' } },
      required: ['path', 'newPath'],
    },
    permission: 'write',
  },
  delete_file: {
    name: 'delete_file',
    description:
      'Delete a file. There is no undo beyond the session checkpoint, so delete only what the task ' +
      'names or what you created yourself.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    permission: 'destructive',
  },
  semantic_search: {
    name: 'semantic_search',
    description:
      'Search the codebase by meaning (embeddings), e.g. "where is authentication handled". Use it ' +
      'when you know what something does but not what it is called; use search when you know the ' +
      'name, the string, or the error text. Falls back to text search when no index exists.',
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
      'The working directory persists between calls (cd carries over) and every result says where it ' +
      'is once it has left the workspace root, so do not re-issue `cd` you have already run. ' +
      'Prefer run_tests for the project\'s test suite, and the file tools over shell equivalents — ' +
      'read_file over cat, edit_file over sed, search over grep — since those report better and are ' +
      'not gated behind the execute permission. Package installs are checked against the registry ' +
      'first and blocked if the package name looks hallucinated. A command that does not return, like ' +
      'a dev server or a watcher, is killed on a timeout: start it in the background and check it ' +
      'separately instead.',
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
      'catches hallucinated package names before they\'re installed. One call answers "is this real"; ' +
      'it is not a way to browse a registry, so do not walk a list of candidate names through it.',
    parameters: {
      type: 'object',
      properties: { registry: { type: 'string', enum: ['npm', 'pypi'] }, name: { type: 'string' } },
      required: ['registry', 'name'],
    },
    permission: 'execute',
  },
  fetch_url: {
    name: 'fetch_url',
    description:
      'Fetch a web page or API over HTTP(S) — documentation, READMEs, API responses. HTML is reduced ' +
      'to readable text. One good page beats another five searches: when a search result looks right, ' +
      'read it rather than searching again.',
    parameters: { type: 'object', properties: { url: { type: 'string', description: 'http(s):// URL' } }, required: ['url'] },
    permission: 'execute',
    // Arbitrary third-party content — same injection posture as MCP (PLAN.md M7).
    untrustedOutput: true,
  },
  download_file: {
    name: 'download_file',
    description:
      'Download a file from the internet and save it into the workspace — an image, a font, a PDF, ' +
      'an archive. Use this rather than curl or wget through run_command: those are classed as plain ' +
      'shell commands, so nothing records that a file arrived from outside. ' +
      'For a page you want to READ, use fetch_url instead — this saves bytes to disk and shows you ' +
      'none of them. Saving an image does not let you see it.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'http(s):// URL of the file to download' },
        path: {
          type: 'string',
          description: 'Where to save it, relative to the workspace. Include the file extension.',
        },
      },
      required: ['url', 'path'],
    },
    // `write`, not `execute`: what this does that matters is land a file in the
    // workspace, and the permission the user is asked for should describe the
    // effect they care about rather than the network call that caused it.
    permission: 'write',
    // The bytes are never shown to the model — only the path, size and type —
    // so the content cannot carry an injection. What IS attacker-influenced is
    // the filename a redirect can suggest, which is why the caller names the
    // path and the server never gets to.
  },
  web_search: {
    name: 'web_search',
    description:
      'Search the web and get back titles, URLs and snippets. Use for current information, ' +
      'library docs, error messages, and anything outside this repository. Follow up with ' +
      'fetch_url to read a result in full — snippets alone are rarely enough to answer from. ' +
      'Two or three searches settle most questions; if yours is not settled by then, rewording it ' +
      'again will not settle it either — read one of the results properly, or ask the user.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        max_results: { type: 'number', description: 'How many results to return (1-10, default 5)' },
      },
      required: ['query'],
    },
    permission: 'execute',
    // Arbitrary third-party content chosen by a model-authored query — the
    // strongest form of the fetch_url/MCP injection posture.
    untrustedOutput: true,
  },
  multi_edit: {
    name: 'multi_edit',
    description:
      'Apply several search/replace edits to one file atomically — all succeed or none are written. ' +
      'Same matching rules as edit_file. Prefer this over a run of edit_file calls on the same file: ' +
      'it cannot leave the file half-changed, and it is one turn instead of five.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              search: { type: 'string', description: 'Existing code to replace' },
              replace: { type: 'string', description: 'New code' },
              replace_all: {
                type: 'boolean',
                description: 'Replace every occurrence rather than requiring "search" to be unique. Default false.',
              },
            },
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
      'Ask the user a question when you are blocked on a decision only they can make — ambiguous ' +
      'requirements, a destructive trade-off, which of two designs they want. Ask ONE question and ' +
      'stop; never answer it yourself. Use sparingly: prefer a sensible default and say what you ' +
      'assumed. But asking beats guessing when the answer changes what gets built, and it beats ' +
      'searching for an answer the codebase does not contain.',
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

/**
 * Delegate a sub-task to a fresh sub-agent. In core (not the sharedAgentTools
 * record) because no host bakes it into its standing list: execution needs
 * cross-cutting context the executors have no business knowing, so hosts
 * always *offer* it and the server does the recursing — while sub-agents are
 * disabled, calling it returns an informative "disabled" error instead of
 * running, which is what keeps the model honest about a capability it cannot
 * currently use.
 *
 * One wording for every host: the two copies this replaced had drifted into
 * saying different things about the same tool, and the model's choice to
 * delegate should not depend on which host it is running in.
 */
export const DELEGATE_TASK_TOOL: ToolDefinition = {
  name: 'delegate_task',
  description:
    'Delegate a self-contained sub-task to a fresh sub-agent with its own context window (no memory of this ' +
    'conversation). Use it for a chunk of work whose intermediate exploration would just clutter your own context ' +
    '— e.g. "investigate and summarize how X works" or "write tests for Y". The sub-agent shares this workspace ' +
    'and its edits use the same checkpoints as your own, but cannot delegate further — one level of nesting only. ' +
    'Runs to completion before returning; there is no parallelism. Use it sparingly: genuinely separable work, ' +
    'not routine steps you could just do directly. ' +
    'The brief is the ceiling of what the sub-agent can do: it has not seen this conversation, does not know what ' +
    'you have already tried or ruled out, and a terse one-line task gets a shallow generic answer. Brief it like a ' +
    'colleague who just walked in — the goal, the surrounding context it needs for judgement calls, exact paths ' +
    'and identifiers rather than "the relevant file" — and never delegate understanding: "based on your findings, ' +
    'fix the bug" hands your synthesis to the agent. Decide first and delegate the doing, or delegate the ' +
    'investigation and do the deciding when the report lands.',
  parameters: {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        description:
          'A self-contained description of the sub-task — the sub-agent has no context beyond this. Include ' +
          'what you already know and what you have ruled out, so it does not re-derive them.',
      },
      persona: {
        type: 'string',
        description: 'Optional: agent, architect, debug, or reviewer. Can never be more permissive than your own persona.',
      },
      profile: { type: 'string', description: 'Optional: run the sub-agent on a different configured provider profile.' },
    },
    required: ['task'],
  },
  permission: 'execute',
};
