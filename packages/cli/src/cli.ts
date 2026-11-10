import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { ScaffoldResult, ScaffoldedFile } from './scaffold.js';
import { scaffold } from './scaffold.js';

const USAGE = `sqlinqo scaffold - generate @sqlinqo/core entities from a PostgreSQL schema

Usage
  sqlinqo scaffold [options]

Options
  -u, --url <string>        Connection string. Defaults to $DATABASE_URL.
  -s, --schema <name>       Schema to read. Defaults to "public".
  -o, --out <dir>           Output directory. Defaults to "src/entities".
      --tables <a,b>        Only these tables. Repeatable, or comma separated.
      --exclude <a,b>       Leave these tables out. Applied after --tables.
      --no-relations        Map columns only, ignoring foreign keys.
      --qualify-schema      Emit \`schema\` on every entity.
      --import-extension <e>  Extension on generated imports. Defaults to ".js";
                            pass "" for a resolver that does not want one.
  -f, --force               Overwrite files that already exist.
      --dry-run             Print what would be written, and write nothing.
  -h, --help                Show this message.
  -v, --version             Show the version.

Examples
  sqlinqo scaffold --url postgres://user@localhost/app --out src/entities
  DATABASE_URL=... sqlinqo scaffold --tables users,orders --dry-run
`;

/**
 * Runs the CLI and answers with a process exit code.
 *
 * Returning the code rather than calling `process.exit` keeps this callable
 * from a test, and leaves the one place that exits in `bin.ts`.
 */
export async function run(argv: readonly string[]): Promise<number> {
  let parsed: ReturnType<typeof parseArgs<typeof PARSE_CONFIG>>;
  try {
    parsed = parseArgs({ ...PARSE_CONFIG, args: [...argv] });
  } catch (error) {
    write(process.stderr, `${message(error)}\n\n${USAGE}`);
    return 2;
  }

  const { values, positionals } = parsed;
  if (values.help) {
    write(process.stdout, USAGE);
    return 0;
  }
  if (values.version) {
    write(process.stdout, `${await version()}\n`);
    return 0;
  }

  const command = positionals[0];
  if (command !== undefined && command !== 'scaffold') {
    write(process.stderr, `Unknown command "${command}".\n\n${USAGE}`);
    return 2;
  }
  if (command === undefined) {
    write(process.stdout, USAGE);
    return 0;
  }

  const out = values.out ?? path.join('src', 'entities');
  try {
    const result = await scaffold({
      connectionString: values.url ?? process.env.DATABASE_URL,
      ...(values.schema ? { schema: values.schema } : {}),
      out,
      ...(list(values.tables) ? { tables: list(values.tables) } : {}),
      ...(list(values.exclude) ? { exclude: list(values.exclude) } : {}),
      relations: values['no-relations'] !== true,
      qualifySchema: values['qualify-schema'] === true,
      ...(values['import-extension'] !== undefined
        ? { importExtension: values['import-extension'] }
        : {}),
      force: values.force === true,
      dryRun: values['dry-run'] === true,
    });

    write(process.stdout, report(result, out, values['dry-run'] === true));
    // A file kept back is not a failure, but it is not the outcome that was
    // asked for either, so it earns a distinct code a script can branch on.
    return result.files.some((file) => file.outcome === 'kept') ? 3 : 0;
  } catch (error) {
    write(process.stderr, `${message(error)}\n`);
    return 1;
  }
}

const PARSE_CONFIG = {
  allowPositionals: true,
  options: {
    url: { type: 'string', short: 'u' },
    schema: { type: 'string', short: 's' },
    out: { type: 'string', short: 'o' },
    tables: { type: 'string', multiple: true },
    exclude: { type: 'string', multiple: true },
    'no-relations': { type: 'boolean' },
    'qualify-schema': { type: 'boolean' },
    'import-extension': { type: 'string' },
    force: { type: 'boolean', short: 'f' },
    'dry-run': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
  },
} as const;

/**
 * Renders the result as the text a person reads after a run.
 *
 * Warnings come before the summary rather than after it: everything they name
 * was left out of the output, so they are the part worth reading, and a long
 * file list should not push them off the top of a terminal.
 */
function report(result: ScaffoldResult, out: string, dryRun: boolean): string {
  const lines: string[] = [];
  const tables = result.model.entities.length;

  lines.push(
    `Read ${count(tables, 'entity', 'entities')} from schema "${result.model.schema}".`,
    '',
  );

  if (result.warnings.length > 0) {
    lines.push(`${count(result.warnings.length, 'warning')}:`);
    for (const warning of result.warnings) lines.push(`  - ${warning}`);
    lines.push('');
  }

  for (const file of result.files) lines.push(`  ${describe(file, dryRun)}`);
  lines.push('');

  const written = result.files.filter(
    (file) => file.outcome === 'created' || file.outcome === 'updated',
  ).length;
  const kept = result.files.filter((file) => file.outcome === 'kept');

  if (dryRun) {
    lines.push(`Nothing written: --dry-run. ${count(written, 'file')} would change.`);
  } else if (written === 0 && kept.length === 0) {
    // The ordinary second run. "Wrote 0 files" is accurate and reads as though
    // something went wrong, where nothing did.
    lines.push(`Already up to date: ${out}.`);
  } else {
    lines.push(`Wrote ${count(written, 'file')} to ${out}.`);
  }

  if (kept.length > 0) {
    lines.push(
      `${count(kept.length, 'file')} already existed and differ. Pass --force to overwrite.`,
    );
  }

  if (written > 0 && !dryRun) {
    lines.push(
      '',
      'Use them:',
      '',
      `  import { entities } from '${specifier(path.join(out, 'index.js'))}';`,
      '',
      '  const db = createPostgresContext({ connectionString, entities });',
    );
  }

  return `${lines.join('\n')}\n`;
}

function describe(file: ScaffoldedFile, dryRun: boolean): string {
  const label: Record<ScaffoldedFile['outcome'], string> = {
    created: dryRun ? 'would create' : 'created',
    updated: dryRun ? 'would update' : 'updated',
    unchanged: 'unchanged',
    kept: 'kept',
  };
  return `${label[file.outcome].padEnd(13)} ${toPosix(relative(file.absolutePath))}`;
}

/** Flattens the repeatable, comma separated form of a list option. */
function list(values: readonly string[] | undefined): string[] | undefined {
  if (!values) return undefined;
  const items = values
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return items.length > 0 ? items : undefined;
}

async function version(): Promise<string> {
  try {
    const manifest = await readFile(new URL('../package.json', import.meta.url), 'utf8');
    return (JSON.parse(manifest) as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function relative(file: string): string {
  const from = path.relative(process.cwd(), file);
  // A path that climbs out of the working directory reads worse relative than
  // absolute, so it is left as it was.
  return from.startsWith('..') ? file : from;
}

/** Import specifiers and printed paths use forward slashes on every platform. */
function toPosix(file: string): string {
  return file.split(path.sep).join('/');
}

/**
 * The path as it would be written in an import.
 *
 * A relative path needs the leading `./` that marks it as relative rather than
 * as a package name. An absolute one must not have it, which is what made the
 * hint read `'./C:/Users/...'` when the output directory was outside the
 * working directory.
 */
function specifier(file: string): string {
  return path.isAbsolute(file) ? toPosix(file) : `./${toPosix(file)}`;
}

function count(value: number, singular: string, plural = `${singular}s`): string {
  return `${value} ${value === 1 ? singular : plural}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function write(stream: NodeJS.WriteStream, text: string): void {
  stream.write(text);
}
