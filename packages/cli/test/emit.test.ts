import { describe, expect, it } from 'vitest';
import { emitBarrel, emitEntity, emitFiles } from '../src/generate/emit.js';
import { buildModel } from '../src/generate/model.js';
import { column, exampleSchema, foreignKey, schema, table } from './support.js';

/** Renders one named entity out of a schema, which is what most cases assert on. */
function render(database: ReturnType<typeof schema>, name: string, options = {}): string {
  const model = buildModel(database);
  const entity = model.entities.find((candidate) => candidate.name === name);
  if (!entity) throw new Error(`No entity named ${name}`);
  return emitEntity(entity, options);
}

describe('emitEntity', () => {
  it('renders the definition the README writes by hand', () => {
    const output = render(exampleSchema(), 'User');

    expect(output).toContain('export const User = defineEntity({');
    expect(output).toContain("  name: 'User',");
    expect(output).toContain("  table: 'users',");
    expect(output).toContain("    id: { type: 'int', primaryKey: true, generated: true },");
    expect(output).toContain("    name: { type: 'text' },");
    expect(output).toContain("    cityId: { type: 'int', column: 'city_id', nullable: true },");
    expect(output).toContain('export type User = EntityOf<typeof User>;');
  });

  it('imports only the helpers the file actually uses', () => {
    // An unused import is an error under a strict lint configuration, and this
    // output is meant to drop into one.
    expect(render(exampleSchema(), 'User')).toContain(
      "import { defineEntity, reference } from '@sqlinqo/core';",
    );
    expect(render(exampleSchema(), 'City')).toContain(
      "import { collection, defineEntity } from '@sqlinqo/core';",
    );

    const plain = render(schema([table('logs', [column('id', 'int4')])]), 'Log');
    expect(plain).toContain("import { defineEntity } from '@sqlinqo/core';");
    expect(plain).not.toContain('reference');
    expect(plain).not.toContain('collection');
  });

  it('imports each navigation target once', () => {
    expect(render(exampleSchema(), 'User')).toContain("import { City } from './city.js';");
  });

  it('imports nothing for a table that points at itself', () => {
    const output = render(
      schema([
        table(
          'employees',
          [
            column('id', 'int4', { primaryKey: true }),
            column('manager_id', 'int4', { nullable: true }),
          ],
          [foreignKey('fk', ['employees', 'manager_id'], ['employees', 'id'])],
        ),
      ]),
      'Employee',
    );

    expect(output).not.toContain("from './employee.js'");
    expect(output).toContain("manager: reference(() => Employee, 'managerId', { optional: true })");
    expect(output).toContain("employees: collection(() => Employee, 'managerId')");
  });

  it('renders an array column with its element type', () => {
    const output = render(
      schema([
        table('posts', [
          column('id', 'int4', { primaryKey: true }),
          column('tags', 'text', { isArray: true, dataType: 'text[]' }),
        ]),
      ]),
      'Post',
    );
    expect(output).toContain("    tags: { type: 'array', of: 'text' },");
  });

  it('honours the requested import extension', () => {
    expect(render(exampleSchema(), 'User', { importExtension: '' })).toContain(
      "import { City } from './city';",
    );
  });

  it('carries a database comment into a doc comment', () => {
    const output = render(
      schema([
        table(
          'users',
          [column('id', 'int4', { primaryKey: true, comment: 'Surrogate key.' })],
          [],
          { comment: 'Customer accounts.' },
        ),
      ]),
      'User',
    );

    expect(output).toContain(' * Customer accounts.');
    expect(output).toContain(' * Table `users`.');
    expect(output).toContain('    /** Surrogate key. */');
  });

  it('cannot be closed out of its own comment by a comment in the database', () => {
    const output = render(
      schema([table('users', [column('id', 'int4')], [], { comment: 'Ends here */ and then' })]),
      'User',
    );
    expect(output).not.toContain('*/ and then');
  });

  it('escapes a quote in a physical name rather than interpolating it raw', () => {
    const output = render(schema([table('users', [column("it's", 'text')])]), 'User');
    expect(output).toContain("column: 'it\\'s'");
  });

  it('breaks an entry too long for one line the way a formatter would', () => {
    const long = 'a_very_long_column_name_that_will_not_fit_on_a_single_line_with_its_options';
    const output = render(
      schema([
        table('t', [column(long, 'int4', { primaryKey: true, nullable: true, hasDefault: true })]),
      ]),
      'T',
    );

    expect(output).toContain('    aVeryLongColumnNameThatWillNotFitOnASingleLineWithItsOptions: {');
    expect(output).toContain("      type: 'int',");
    expect(output).toContain('      primaryKey: true,');
    expect(output.split('\n').every((line) => line.length <= 100)).toBe(true);
  });

  it('names the schema only when the model carries one', () => {
    const model = buildModel(exampleSchema(), { qualifySchema: true });
    const user = model.entities.find((entity) => entity.name === 'User');
    expect(emitEntity(user!)).toContain("  schema: 'public',");
    expect(render(exampleSchema(), 'User')).not.toContain('schema:');
  });
});

describe('emitBarrel', () => {
  it('re-exports every entity and maps it to its context key', () => {
    const output = emitBarrel(buildModel(exampleSchema()));

    expect(output).toContain("export * from './city.js';");
    expect(output).toContain("export * from './user.js';");
    expect(output).toContain('export const entities = {');
    expect(output).toContain('  cities: City,');
    expect(output).toContain('  users: User,');
  });

  it('stays a module when there is nothing to export', () => {
    const output = emitBarrel(buildModel(schema([])));
    expect(output).toContain('export {};');
  });
});

describe('emitFiles', () => {
  it('writes one file per entity plus the barrel', () => {
    const files = emitFiles(buildModel(exampleSchema()));
    expect(files.map((file) => file.path)).toEqual(['city.ts', 'user.ts', 'index.ts']);
  });

  it('ends every file with exactly one newline', () => {
    for (const file of emitFiles(buildModel(exampleSchema()))) {
      expect(file.contents.endsWith('\n')).toBe(true);
      expect(file.contents.endsWith('\n\n')).toBe(false);
    }
  });
});
