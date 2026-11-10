/**
 * Base class for every error raised by the query pipeline.
 *
 * Having a single root makes it possible for consumers to write
 * `catch (e) { if (e instanceof LinqError) ... }` without importing each
 * concrete class.
 */
export class LinqError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    // Restores the prototype chain when the package is transpiled down to ES5
    // by a consumer's bundler.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** The lambda source could not be tokenized or parsed. */
export class ParseError extends LinqError {
  constructor(
    message: string,
    readonly source: string,
    readonly position: number,
  ) {
    super(`${message} (at offset ${position} in: ${truncate(source)})`);
  }
}

/**
 * The lambda parsed correctly but uses a construct the translator cannot turn
 * into SQL, for example calling an arbitrary user function inside `where`.
 */
export class UnsupportedExpressionError extends LinqError {}

/** The query plan is structurally invalid, for example `thenBy` without `orderBy`. */
export class InvalidQueryError extends LinqError {}

/** The requested row count did not match what `first`/`single`/`toDictionary` demands. */
export class SequenceError extends LinqError {}

/** The entity model is inconsistent, for example a column mapped twice. */
export class ModelError extends LinqError {}

function truncate(value: string, max = 120): string {
  const flattened = value.replace(/\s+/g, ' ').trim();
  return flattened.length <= max ? flattened : `${flattened.slice(0, max)}...`;
}
