import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
  resolve: {
    alias: {
      // `vscode` only exists inside a real extension host, so any extension
      // code importing it at runtime is otherwise untestable. Only
      // packages/vscode imports it; see packages/vscode/test/vscodeStub.ts.
      vscode: fileURLToPath(new URL('./packages/vscode/test/vscodeStub.ts', import.meta.url)),
    },
  },
});
