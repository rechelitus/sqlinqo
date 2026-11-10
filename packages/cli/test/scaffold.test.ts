import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scaffold } from '../src/scaffold.js';
import { FakeReader, exampleSchema } from './support.js';

describe('scaffold', () => {
  let out: string;

  beforeEach(async () => {
    out = await mkdtemp(path.join(tmpdir(), 'sqlinqo-cli-'));
  });

  afterEach(async () => {
    await rm(out, { recursive: true, force: true });
  });

  const run = (options: Partial<Parameters<typeof scaffold>[0]> = {}) =>
    scaffold({ out, reader: new FakeReader(exampleSchema()), ...options });

  it('writes one file per entity and a barrel', async () => {
    const result = await run();

    expect(result.files.map((file) => file.path)).toEqual(['city.ts', 'user.ts', 'index.ts']);
    expect(result.files.every((file) => file.outcome === 'created')).toBe(true);
    await expect(readFile(path.join(out, 'user.ts'), 'utf8')).resolves.toContain("table: 'users',");
  });

  it('creates the output directory', async () => {
    const nested = path.join(out, 'src', 'entities');
    await scaffold({ out: nested, reader: new FakeReader(exampleSchema()) });
    await expect(readFile(path.join(nested, 'index.ts'), 'utf8')).resolves.toContain('entities');
  });

  it('reports a second run as unchanged and rewrites nothing', async () => {
    await run();
    const result = await run();

    // Rewriting an identical file moves a timestamp and can trigger a rebuild
    // downstream, which is a cost for no change at all.
    expect(result.files.every((file) => file.outcome === 'unchanged')).toBe(true);
  });

  it('keeps an edited file rather than discarding the edit', async () => {
    await run();
    const file = path.join(out, 'user.ts');
    await writeFile(file, '// edited by hand\n', 'utf8');

    const result = await run();
    expect(result.files.find((f) => f.path === 'user.ts')?.outcome).toBe('kept');
    await expect(readFile(file, 'utf8')).resolves.toBe('// edited by hand\n');
  });

  it('overwrites an edited file when forced', async () => {
    await run();
    const file = path.join(out, 'user.ts');
    await writeFile(file, '// edited by hand\n', 'utf8');

    const result = await run({ force: true });
    expect(result.files.find((f) => f.path === 'user.ts')?.outcome).toBe('updated');
    await expect(readFile(file, 'utf8')).resolves.toContain("table: 'users',");
  });

  it('writes nothing on a dry run but still reports what would change', async () => {
    const result = await run({ dryRun: true });

    expect(result.files.every((file) => file.outcome === 'created')).toBe(true);
    await expect(readFile(path.join(out, 'user.ts'), 'utf8')).rejects.toThrow();
  });

  it('refuses to connect without a connection string', async () => {
    await expect(scaffold({ out })).rejects.toThrow(/DATABASE_URL/);
  });

  it('carries the model and its warnings back to the caller', async () => {
    const result = await run();
    expect(result.model.entities).toHaveLength(2);
    expect(result.warnings).toEqual([]);
  });
});
