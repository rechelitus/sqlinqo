import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  // A dedicated tsconfig: the package tsconfig is a composite project, which
  // the declaration bundler cannot consume directly.
  tsconfig: 'tsconfig.build.json',
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: 'es2022',
  // `mssql` stays external so the consumer controls the client version, and
  // `@sqlinqo/core` is shared rather than duplicated into this bundle.
  external: ['mssql', '@sqlinqo/core'],
  outExtension: ({ format }) => ({ js: format === 'cjs' ? '.cjs' : '.js' }),
});
