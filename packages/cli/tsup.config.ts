import { defineConfig } from 'tsup';

export default defineConfig({
  // `bin` is a second entry rather than part of `index`, so importing the
  // package as a library never drags in the argument parser or the process
  // exit codes that only make sense for an executable.
  entry: ['src/index.ts', 'src/bin.ts'],
  format: ['esm', 'cjs'],
  dts: { entry: 'src/index.ts' },
  // A dedicated tsconfig: the package tsconfig is a composite project, which
  // the declaration bundler cannot consume directly.
  tsconfig: 'tsconfig.build.json',
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: 'es2022',
  outExtension: ({ format }) => ({ js: format === 'cjs' ? '.cjs' : '.js' }),
});
