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
);
