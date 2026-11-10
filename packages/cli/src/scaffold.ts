import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { EmitOptions, GeneratedFile } from './generate/emit.js';
import { emitFiles } from './generate/emit.js';
import type { BuildModelOptions, EntityModel } from './generate/model.js';
import { buildModel } from './generate/model.js';
import { PostgresSchemaReader } from './schema/postgres.js';
import type { SchemaReader } from './schema/types.js';

export interface ScaffoldOptions extends BuildModelOptions, EmitOptions {
  /** PostgreSQL connection string. Required unless a reader is supplied. */
  readonly connectionString?: string;
  readonly schema?: string;
  /** Directory the files are written to, resolved against the process cwd. */
  readonly out: string;
  /** Physical table names to scaffold. Empty means every table in the schema. */
  readonly tables?: readonly string[];
  readonly exclude?: readonly string[];
  /** Overwrite files that already exist. Off by default. */
  readonly force?: boolean;
  /** Produce the files without writing them. */
  readonly dryRun?: boolean;
  /** Read through this instead of connecting. Used by the tests. */
  readonly reader?: SchemaReader;
}

/** What a file turned out to be once the directory was inspected. */
export type FileOutcome = 'created' | 'updated' | 'unchanged' | 'kept';

export interface ScaffoldedFile extends GeneratedFile {
  /** Absolute path the file was or would be written to. */
  readonly absolutePath: string;
  readonly outcome: FileOutcome;
}

export interface ScaffoldResult {
  readonly model: EntityModel;
  readonly files: readonly ScaffoldedFile[];
  readonly warnings: readonly string[];
}

/**
 * Reads a schema and writes the entities it describes.
 *
 * The reader, the model and the emitter are separate steps and stay that way
 * here: this function only decides what lands on disk. A run that writes
 * nothing, whether because `dryRun` was asked for or because every file already
 * existed, still returns the full result, so the caller can report what a real
 * run would have done.
 */
export async function scaffold(options: ScaffoldOptions): Promise<ScaffoldResult> {
  const reader = options.reader ?? postgresReader(options);
  const schema = await reader.read();

  const model = buildModel(schema, options);
  const generated = emitFiles(model, options);
  const directory = path.resolve(options.out);

  const files = await Promise.all(
    generated.map(async (file): Promise<ScaffoldedFile> => {
      const absolutePath = path.join(directory, file.path);
      const existing = await read(absolutePath);
      return { ...file, absolutePath, outcome: outcomeFor(existing, file.contents, options) };
    }),
  );

  if (!options.dryRun) {
    await mkdir(directory, { recursive: true });
    await Promise.all(
      files
        .filter((file) => file.outcome === 'created' || file.outcome === 'updated')
        .map((file) => writeFile(file.absolutePath, file.contents, 'utf8')),
    );
  }

  return { model, files, warnings: model.warnings };
}

function postgresReader(options: ScaffoldOptions): SchemaReader {
  if (!options.connectionString) {
    throw new Error('No connection string. Pass --url, or set DATABASE_URL in the environment.');
  }
  return new PostgresSchemaReader({
    connectionString: options.connectionString,
    ...(options.schema ? { schema: options.schema } : {}),
    ...(options.tables ? { include: options.tables } : {}),
    ...(options.exclude ? { exclude: options.exclude } : {}),
  });
}

/**
 * What will happen to one file.
 *
 * A file whose contents already match is reported as `unchanged` rather than
 * rewritten, so a second run leaves no timestamps moved and no rebuild
 * triggered. One that differs is kept unless `force` says otherwise: the header
 * invites editing the output, and a generator that quietly discards those edits
 * would be a poor thing to have invited it with.
 */
function outcomeFor(
  existing: string | null,
  contents: string,
  options: ScaffoldOptions,
): FileOutcome {
  if (existing === null) return 'created';
  if (existing === contents) return 'unchanged';
  return options.force ? 'updated' : 'kept';
}

async function read(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
