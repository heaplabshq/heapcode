import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/out/**', '**/media/webview/**', '**/*.vsix'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // Guardrail #3: core must stay IDE-agnostic.
    files: ['packages/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: [{ name: 'vscode', message: 'packages/core must not depend on the VS Code API. Inject IDE capabilities through interfaces instead.' }] },
      ],
    },
  },
  {
    // Guardrail #4: the subpaths hosts without Node import from — `@heapcode/core/agent`,
    // `/providers`, `/context` — must stay free of Node builtins, so an MV3 extension or a
    // web worker can bundle the agent loop without `node:child_process` coming with it.
    //
    // The exempted files are the Node-coupled agent modules, reachable only through the
    // package barrel: `workspaceTools` shells out, `webSearch` reaches child_process through
    // it, `mcp`'s stdio transport does the same via the SDK, and `environment` runs `git` to
    // gather the prompt's environment block.
    //
    // This rule catches the direct case and gives fast feedback. It cannot catch coupling that
    // arrives through a relative import — `webSearch` -> `workspaceTools` -> `node:child_process`
    // is invisible to it — so the restricted paths below name the known escape hatches, and
    // `packages/core/test/browserSafety.test.ts` walks the real transitive graph. The test is
    // the guardrail that actually holds; treat this rule as the fast half of it.
    files: ['packages/core/src/agent/**/*.ts', 'packages/core/src/providers/**/*.ts', 'packages/core/src/context/**/*.ts'],
    ignores: [
      'packages/core/src/agent/workspaceTools.ts',
      'packages/core/src/agent/webSearch.ts',
      'packages/core/src/agent/mcp.ts',
      'packages/core/src/agent/environment.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [{ name: 'vscode', message: 'packages/core must not depend on the VS Code API. Inject IDE capabilities through interfaces instead.' }],
          patterns: [
            {
              group: ['node:*', 'node:*/**'],
              message:
                'This module is reachable from the browser-safe subpaths (@heapcode/core/agent, /providers, /context) and must not import Node builtins. Move the Node-only work behind a seam in src/fs.ts and implement it in src/node/, the way nodeTextFile does.',
            },
            {
              group: ['**/workspaceTools.js', '**/webSearch.js', '**/mcp.js', '**/net/safeFetch.js', '**/node/*.js', '**/server/*.js'],
              message:
                'This module is reachable from the browser-safe subpaths and must not import a Node-coupled module, even relatively — the Node builtin comes along transitively. See packages/core/src/agent/index.ts for the boundary.',
            },
          ],
        },
      ],
    },
  },
);
