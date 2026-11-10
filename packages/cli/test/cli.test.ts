import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../src/cli.js';

/**
 * Drives the CLI the way a shell would and captures what it printed.
 *
 * The streams are stubbed rather than the functions that write to them, so a
 * test fails if the CLI starts printing through some other route.
 */
async function cli(args: readonly string[]): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  let stdout = '';
  let stderr = '';
  const out = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk) => ((stdout += String(chunk)), true));
  const error = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk) => ((stderr += String(chunk)), true));

  try {
    return { code: await run(args), stdout, stderr };
  } finally {
    out.mockRestore();
    error.mockRestore();
  }
}

describe('run', () => {
  let out: string;
  const previousUrl = process.env['DATABASE_URL'];

  beforeEach(async () => {
    out = await mkdtemp(path.join(tmpdir(), 'sqlinqo-cli-run-'));
    // The connection is never opened in these tests, but its absence is its own
    // error, so it is cleared to keep the two apart.
    delete process.env['DATABASE_URL'];
  });

  afterEach(async () => {
    await rm(out, { recursive: true, force: true });
    if (previousUrl === undefined) delete process.env['DATABASE_URL'];
    else process.env['DATABASE_URL'] = previousUrl;
  });

  it('prints usage and succeeds when asked for help', async () => {
    const result = await cli(['--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('sqlinqo scaffold');
    expect(result.stdout).toContain('--dry-run');
  });

  it('prints usage when given no command at all', async () => {
    const result = await cli([]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Usage');
  });

  it('prints a version', async () => {
    const result = await cli(['--version']);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$|^unknown$/);
  });

  it('rejects an unknown command with a usage code', async () => {
    const result = await cli(['migrate']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('Unknown command "migrate"');
  });

  it('rejects an unknown option with a usage code', async () => {
    const result = await cli(['scaffold', '--nonsense']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('Usage');
  });

  it('fails with a plain message when there is no connection string', async () => {
    const result = await cli(['scaffold', '--out', out]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('DATABASE_URL');
    // A missing connection string is a mistake, not a crash.
    expect(result.stderr).not.toContain('at ');
  });
});

/**
 * The reporting paths, driven through a fake database.
 *
 * `scaffold` is stubbed rather than the driver: these tests are about what the
 * CLI does with a result, and the result itself is covered elsewhere.
 */
describe('run, reporting', () => {
  let out: string;

  beforeEach(async () => {
    out = await mkdtemp(path.join(tmpdir(), 'sqlinqo-cli-report-'));
    process.env['DATABASE_URL'] = 'postgres://unused@localhost/unused';
    const { FakeReader, exampleSchema } = await import('./support.js');
    const scaffoldModule = await import('../src/scaffold.js');
    const real = scaffoldModule.scaffold;
    vi.spyOn(scaffoldModule, 'scaffold').mockImplementation((options) =>
      real({ ...options, reader: new FakeReader(exampleSchema()) }),
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(out, { recursive: true, force: true });
    delete process.env['DATABASE_URL'];
  });

  it('writes the entities and says where they went', async () => {
    const result = await cli(['scaffold', '--out', out]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Read 2 entities from schema "public"');
    expect(result.stdout).toContain('Wrote 3 files');
    await expect(readFile(path.join(out, 'user.ts'), 'utf8')).resolves.toContain("table: 'users',");
  });

  it('says so plainly when a second run has nothing to do', async () => {
    await cli(['scaffold', '--out', out]);
    const result = await cli(['scaffold', '--out', out]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Already up to date');
    expect(result.stdout).not.toContain('Wrote 0 files');
  });

  it('writes nothing on a dry run', async () => {
    const result = await cli(['scaffold', '--out', out, '--dry-run']);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('would create');
    expect(result.stdout).toContain('Nothing written: --dry-run');
    await expect(readFile(path.join(out, 'user.ts'), 'utf8')).rejects.toThrow();
  });

  it('answers with a distinct code when a file was kept back', async () => {
    await cli(['scaffold', '--out', out]);
    await writeFile(path.join(out, 'user.ts'), '// mine\n', 'utf8');

    const result = await cli(['scaffold', '--out', out]);
    // Not a failure, and not the outcome that was asked for either.
    expect(result.code).toBe(3);
    expect(result.stdout).toContain('Pass --force to overwrite');
    await expect(readFile(path.join(out, 'user.ts'), 'utf8')).resolves.toBe('// mine\n');
  });

  it('overwrites when forced', async () => {
    await cli(['scaffold', '--out', out]);
    await writeFile(path.join(out, 'user.ts'), '// mine\n', 'utf8');

    const result = await cli(['scaffold', '--out', out, '--force']);
    expect(result.code).toBe(0);
    await expect(readFile(path.join(out, 'user.ts'), 'utf8')).resolves.toContain("table: 'users',");
  });

  it('leaves relations out when told to', async () => {
    await cli(['scaffold', '--out', out, '--no-relations']);
    const user = await readFile(path.join(out, 'user.ts'), 'utf8');
    expect(user).not.toContain('relations');
    expect(user).toContain("cityId: { type: 'int', column: 'city_id', nullable: true },");
  });

  it('honours an empty import extension', async () => {
    await cli(['scaffold', '--out', out, '--import-extension', '']);
    await expect(readFile(path.join(out, 'index.ts'), 'utf8')).resolves.toContain(
      "export * from './user';",
    );
  });

  it('writes an import hint that is a legal specifier', async () => {
    // An absolute output path must not gain the `./` that marks a relative one.
    const result = await cli(['scaffold', '--out', out]);
    expect(result.stdout).not.toContain("'./" + path.parse(out).root.replace(/\\/g, '/'));
    expect(result.stdout).toMatch(/import \{ entities \} from '[^']+index\.js';/);
  });
});
