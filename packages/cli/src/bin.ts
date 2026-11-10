#!/usr/bin/env node
import { run } from './cli.js';

// The only place in the package that ends the process. `run` answers with a
// code rather than exiting itself, which is what keeps everything above it
// callable from a test.
//
// Written as a `then` rather than a top-level `await` so the same source builds
// as CommonJS too, which has no such thing. `run` handles its own failures, so
// the rejection branch is for the ones it could not have expected.
run(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  },
);
