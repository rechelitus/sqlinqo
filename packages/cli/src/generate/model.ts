import type { ColumnType, ScalarColumnType } from '@sqlinqo/core';
import type { DatabaseSchema, ForeignKeyInfo, TableInfo } from '../schema/types.js';
import { mapColumnType } from './column-type.js';
import {
  camelCase,
  collectionName,
  contextKey,
  entityName,
  kebabCase,
  referenceName,
  unique,
} from './naming.js';

/** One entry of a generated entity's column map. */
export interface GeneratedColumn {
  /** Property name in the model. */
  readonly property: string;
  /** Physical column name, emitted only when it differs from the property. */
  readonly column: string;
  readonly type: ColumnType;
  readonly of?: ScalarColumnType;
  readonly primaryKey: boolean;
  readonly nullable: boolean;
  readonly generated: boolean;
  readonly comment: string | null;
}

export interface GeneratedReference {
  readonly kind: 'reference';
  readonly property: string;
  /** Entity name of the target, which is also its exported binding. */
  readonly target: string;
  /** Module the target is imported from, without an extension. */
  readonly targetFile: string;
  /** Property on this entity holding the key. */
  readonly from: string;
  /** Property on the target, omitted when it is the target's primary key. */
  readonly to?: string;
  readonly optional: boolean;
}

export interface GeneratedCollection {
  readonly kind: 'collection';
  readonly property: string;
  readonly target: string;
  readonly targetFile: string;
  /** Property on the target holding the key that points back here. */
  readonly from: string;
  /** Property here, omitted when it is this entity's primary key. */
  readonly to?: string;
}

export type GeneratedRelation = GeneratedReference | GeneratedCollection;

export interface GeneratedEntity {
  /** Exported binding and `name` in the definition, such as `User`. */
  readonly name: string;
  readonly table: string;
  /** Emitted only when the schema is not the connection's default. */
  readonly schema: string | undefined;
  /** Property this entity is reached through on the context. */
  readonly contextKey: string;
  /** File name without an extension, such as `order-item`. */
  readonly file: string;
  readonly comment: string | null;
  readonly columns: readonly GeneratedColumn[];
  readonly relations: readonly GeneratedRelation[];
}

export interface EntityModel {
  readonly schema: string;
  readonly entities: readonly GeneratedEntity[];
  /**
   * Everything the generator declined to map, in the order it was met.
   *
   * A warning is always about something left out of the output, never about
   * something put in it, so a run with no warnings scaffolded the whole schema.
   */
  readonly warnings: readonly string[];
}

export interface BuildModelOptions {
  /** When false, foreign keys are read as plain columns and nothing else. */
  readonly relations?: boolean;
  /**
   * Emit `schema` on every entity.
   *
   * Off by default: a scaffold of `public` that names it stops the model from
   * working against a connection whose `search_path` says otherwise, which is
   * how the same code usually reaches a test database and a live one.
   */
  readonly qualifySchema?: boolean;
}

/**
 * Turns a schema description into the entities to be emitted.
 *
 * This is where every convention is applied and every refusal is decided, which
 * is what keeps the emitter a pure rendering step: by the time it runs, each
 * name is final and each relation has both of its ends.
 */
export function buildModel(schema: DatabaseSchema, options: BuildModelOptions = {}): EntityModel {
  const warnings: string[] = [];
  const withRelations = options.relations ?? true;

  // Entity names are unique across the model rather than per table, since each
  // one becomes a file and an exported binding.
  const takenNames = new Set<string>();
  const takenKeys = new Set<string>();

  const drafts = new Map<string, EntityDraft>();
  for (const table of schema.tables) {
    const draft = draftEntity(table, takenNames, takenKeys, warnings, options);
    if (draft) drafts.set(table.name, draft);
  }

  if (withRelations) {
    for (const table of schema.tables) {
      const child = drafts.get(table.name);
      if (!child) continue;
      for (const key of table.foreignKeys) {
        addRelation(key, child, drafts, warnings);
      }
    }
  }

  return {
    schema: schema.schema,
    entities: [...drafts.values()].map((draft): GeneratedEntity => ({
      name: draft.name,
      table: draft.table,
      schema: draft.schema,
      contextKey: draft.contextKey,
      file: draft.file,
      comment: draft.comment,
      columns: draft.columns,
      relations: draft.relations,
    })),
    warnings,
  };
}

/**
 * An entity while it is still being assembled.
 *
 * `members` is the reason this exists: `defineEntity` rejects a relation that
 * shares a name with a column, and relations are added in a second pass, so the
 * set of names already spoken for has to outlive the first one. `byColumn` maps
 * a physical column back to its property, which is how a foreign key finds the
 * property to hang a navigation off.
 */
interface EntityDraft {
  readonly name: string;
  readonly table: string;
  readonly schema: string | undefined;
  readonly contextKey: string;
  readonly file: string;
  readonly comment: string | null;
  readonly columns: GeneratedColumn[];
  readonly relations: GeneratedRelation[];
  readonly members: Set<string>;
  readonly byColumn: Map<string, GeneratedColumn>;
  readonly primaryKey: readonly string[];
}

function draftEntity(
  table: TableInfo,
  takenNames: Set<string>,
  takenKeys: Set<string>,
  warnings: string[],
  options: BuildModelOptions,
): EntityDraft | null {
  const members = new Set<string>();
  const columns: GeneratedColumn[] = [];
  const byColumn = new Map<string, GeneratedColumn>();

  for (const column of table.columns) {
    const mapped = mapColumnType(column);
    if (!mapped) {
      warnings.push(
        `${table.name}.${column.name}: no logical type for "${column.dataType}", so the ` +
          'column is left out of the entity. Map it by hand if a query needs it.',
      );
      continue;
    }

    const generated: GeneratedColumn = {
      property: unique(camelCase(column.name), members),
      column: column.name,
      type: mapped.type,
      ...(mapped.of ? { of: mapped.of } : {}),
      primaryKey: column.primaryKey,
      nullable: column.nullable,
      // A default, an identity and a stored generated column are all values the
      // database produces rather than the caller, which is what `generated`
      // records. The engine does nothing with it yet, but it is true now and
      // recovering it later would mean reading the schema again.
      generated: column.hasDefault || column.isIdentity || column.isStored,
      comment: column.comment,
    };
    columns.push(generated);
    byColumn.set(column.name, generated);
  }

  if (columns.length === 0) {
    warnings.push(`${table.name}: no column could be mapped, so no entity was generated for it.`);
    return null;
  }
  if (!columns.some((column) => column.primaryKey)) {
    // Not fatal: `defineEntity` allows an empty primary key and reading still
    // works. Say so, because anything that needs to identify a row will not.
    warnings.push(`${table.name}: no primary key, so the entity declares none.`);
  }

  // The file is named from the de-duplicated entity name rather than from the
  // table, so two tables that want the same entity name do not also want the
  // same file and silently overwrite one another.
  const name = unique(entityName(table.name), takenNames);

  return {
    name,
    table: table.name,
    schema: options.qualifySchema ? table.schema : undefined,
    contextKey: unique(contextKey(table.name), takenKeys),
    file: kebabCase(name),
    comment: table.comment,
    columns,
    relations: [],
    members,
    byColumn,
    primaryKey: columns.filter((column) => column.primaryKey).map((column) => column.property),
  };
}

/**
 * Adds both ends of one foreign key: a reference here, a collection there.
 *
 * Every reason to decline is checked before either end is added, so a key is
 * never half-mapped. A reference with no collection behind it would still
 * compile, and would be the harder kind of wrong to notice.
 */
function addRelation(
  key: ForeignKeyInfo,
  child: EntityDraft,
  drafts: ReadonlyMap<string, EntityDraft>,
  warnings: string[],
): void {
  const parent = drafts.get(key.targetTable);
  if (!parent) return;

  if (key.columns.length !== 1) {
    warnings.push(
      `${key.table}: foreign key "${key.name}" spans ${key.columns.length} columns ` +
        `(${key.columns.join(', ')}), and a navigation names one, so no relation was generated.`,
    );
    return;
  }

  const keyColumn = key.columns[0] as string;
  const targetColumn = key.targetColumns[0] as string;
  const from = child.byColumn.get(keyColumn);
  const to = parent.byColumn.get(targetColumn);
  if (!from || !to) {
    warnings.push(
      `${key.table}: foreign key "${key.name}" uses a column that could not be mapped, ` +
        'so no relation was generated.',
    );
    return;
  }

  // Both ends default `to` to the parent's primary key, so it is emitted only
  // where the key points somewhere else, such as at a unique column.
  const explicitTo = isSolePrimaryKey(parent, to.property) ? undefined : to.property;

  child.relations.push({
    kind: 'reference',
    property: unique(referenceName(keyColumn, key.targetTable), child.members),
    target: parent.name,
    targetFile: parent.file,
    from: from.property,
    ...(explicitTo ? { to: explicitTo } : {}),
    // A nullable key is a row that need not exist, which is a left join and a
    // nullable reading of every column behind it.
    optional: from.nullable,
  });

  parent.relations.push({
    kind: 'collection',
    property: unique(collectionName(child.table), parent.members),
    target: child.name,
    targetFile: child.file,
    from: from.property,
    ...(explicitTo ? { to: explicitTo } : {}),
  });
}

/** True when a property is the whole of its entity's primary key. */
function isSolePrimaryKey(entity: EntityDraft, property: string): boolean {
  return entity.primaryKey.length === 1 && entity.primaryKey[0] === property;
}
