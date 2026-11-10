import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const fromRoot = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'packages/*/src/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/index.ts', '**/*.d.ts'],
    },
  },
  resolve: {
    // Run the tests against TypeScript sources rather than built output so a
    // failing test points at a real line in src/ and no build step is required.
    alias: {
      '@sqlinqo/core': fromRoot('./packages/core/src/index.ts'),
      '@sqlinqo/postgres': fromRoot('./packages/provider-postgres/src/index.ts'),
      '@sqlinqo/cli': fromRoot('./packages/cli/src/index.ts'),
    },
  },
});
