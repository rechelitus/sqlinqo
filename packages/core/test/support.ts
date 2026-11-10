import type { Driver, PreparedStatement, ResultRow } from '../src/index.js';
import { BaseDialect, collection, defineEntity, reference } from '../src/index.js';

/**
 * A minimal ANSI dialect so the core tests can exercise the compiler without
 * depending on a provider package.
 */
export class TestDialect extends BaseDialect {
  readonly name = 'test';

  override quoteIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`;
  }

  override parameterPlaceholder(index: number): string {
    return `$${index + 1}`;
  }
}

export const testDialect = new TestDialect();

/** Records the statements it is handed and replays canned rows. */
export class FakeDriver implements Driver {
  readonly name = 'fake';
  readonly statements: PreparedStatement[] = [];
  closed = false;

  constructor(private rows: ResultRow[] = []) {}

  setRows(rows: ResultRow[]): void {
    this.rows = rows;
  }

  async execute(statement: PreparedStatement): Promise<ResultRow[]> {
    this.statements.push(statement);
    return this.rows;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  get lastStatement(): PreparedStatement {
    const statement = this.statements.at(-1);
    if (!statement) throw new Error('No statement has been executed.');
    return statement;
  }
}

export const User = defineEntity({
  name: 'User',
  table: 'users',
  columns: {
    id: { type: 'int', primaryKey: true, generated: true },
    name: { type: 'text' },
    email: { type: 'text' },
    age: { type: 'int' },
    cityId: { type: 'int', column: 'city_id', nullable: true },
    isActive: { type: 'boolean', column: 'is_active' },
    createdAt: { type: 'timestamp', column: 'created_at' },
  },
  relations: {
    city: reference(() => City, 'cityId', { optional: true }),
    // Only exercised by the query-filter tests. `Post` has no relation back
    // to `User`, so this is one-way, the way `Order -> Line -> Catalogue` is:
    // two entities pointing at each other sends TypeScript's inference to
    // pieces across the whole suite rather than to one line.
    posts: collection(() => Post, 'userId'),
  },
});

export const Order = defineEntity({
  name: 'Order',
  schema: 'sales',
  table: 'orders',
  columns: {
    id: { type: 'int', primaryKey: true },
    userId: { type: 'int', column: 'user_id' },
    total: { type: 'decimal' },
  },
  relations: {
    user: reference(() => User, 'userId'),
    lines: collection(() => Line, 'orderId'),
  },
});

export const Line = defineEntity({
  name: 'Line',
  table: 'order_lines',
  columns: {
    id: { type: 'int', primaryKey: true },
    orderId: { type: 'int', column: 'order_id' },
    sku: { type: 'text' },
  },
  relations: {
    // Keyed on a column the line already has, so nothing about the columns of
    // this entity changes and the SQL every other test asserts is untouched.
    catalogue: reference(() => Catalogue, 'sku'),
  },
});

export const Catalogue = defineEntity({
  name: 'Catalogue',
  table: 'catalogue',
  columns: {
    sku: { type: 'text', primaryKey: true },
    title: { type: 'text' },
  },
});

/**
 * A soft-deleted row, to exercise a global query filter: `db.posts` itself, a
 * reference to one, and a collection of them all have to hide a deleted row
 * without a caller writing a `where` for it. It has no relations of its own,
 * for the same one-way reason `User.posts` above notes.
 */
export const Post = defineEntity({
  name: 'Post',
  table: 'posts',
  columns: {
    id: { type: 'int', primaryKey: true },
    userId: { type: 'int', column: 'user_id' },
    title: { type: 'text' },
    isDeleted: { type: 'boolean', column: 'is_deleted' },
  },
  filter: (post) => !post.isDeleted,
});

/** References `Post`, to exercise a reference navigated to a filtered entity. */
export const Comment = defineEntity({
  name: 'Comment',
  table: 'comments',
  columns: {
    id: { type: 'int', primaryKey: true },
    postId: { type: 'int', column: 'post_id' },
    body: { type: 'text' },
  },
  relations: {
    post: reference(() => Post, 'postId'),
  },
});

export const City = defineEntity({
  name: 'City',
  table: 'cities',
  columns: {
    id: { type: 'int', primaryKey: true },
    name: { type: 'text' },
    country: { type: 'text' },
  },
});

/**
 * Replays a scripted sequence of result sets, one per statement.
 *
 * A paging operator issues several statements in a row and expects a different
 * page back from each, which one canned result set cannot express.
 */
export class PagingDriver implements Driver {
  readonly name = 'paging';
  readonly statements: PreparedStatement[] = [];
  closed = false;

  constructor(private readonly pages: ResultRow[][]) {}

  async execute(statement: PreparedStatement): Promise<ResultRow[]> {
    this.statements.push(statement);
    return this.pages.shift() ?? [];
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
