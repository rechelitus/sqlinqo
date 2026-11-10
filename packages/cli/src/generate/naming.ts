/**
 * Turning physical names into TypeScript ones.
 *
 * Everything here is a convention rather than a fact the database told us, so
 * each function is a heuristic and is documented as one. The generated code
 * always states `table` and `column` explicitly, which means a name this module
 * gets wrong is a one-word edit in the output and never a broken query.
 */

/** Words that are their own plural, so neither direction should touch them. */
const UNCOUNTABLE = new Set([
  'data',
  'deer',
  'equipment',
  'fish',
  'information',
  'money',
  'news',
  'series',
  'sheep',
  'species',
  'staff',
]);

/** Plurals no rule produces, listed singular first. */
const IRREGULAR: readonly (readonly [string, string])[] = [
  ['person', 'people'],
  ['child', 'children'],
  ['man', 'men'],
  ['woman', 'women'],
  ['tooth', 'teeth'],
  ['foot', 'feet'],
  ['mouse', 'mice'],
  ['goose', 'geese'],
  ['leaf', 'leaves'],
  ['life', 'lives'],
  ['knife', 'knives'],
  ['wife', 'wives'],
  ['half', 'halves'],
  ['self', 'selves'],
];

const TO_PLURAL = new Map(IRREGULAR);
const TO_SINGULAR = new Map(IRREGULAR.map(([one, many]) => [many, one]));

/**
 * Splits an identifier into its words, whatever convention wrote it.
 *
 * `user_id`, `userId` and `UserID` all come apart the same way. The run of
 * capitals is handled so that `HTTPStatus` splits into two words rather than
 * into one word per letter.
 */
export function splitWords(identifier: string): string[] {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .flatMap((part) => (part.length > 0 ? [part] : []));
}

/** `user_id` becomes `userId`. Leading digits are prefixed, never dropped. */
export function camelCase(identifier: string): string {
  const words = splitWords(identifier);
  if (words.length === 0) return identifier;
  const [first, ...rest] = words as [string, ...string[]];
  return safeIdentifier(first.toLowerCase() + rest.map(capitalize).join(''));
}

/** `user_id` becomes `UserId`. */
export function pascalCase(identifier: string): string {
  const words = splitWords(identifier);
  if (words.length === 0) return identifier;
  return safeIdentifier(words.map(capitalize).join(''));
}

/**
 * A best guess at the singular of a word.
 *
 * The `-ies` rule is the one that misses: `categories` is `category` and
 * `movies` is `movie`, and nothing in the spelling separates them. The common
 * reading wins and the rare one is a rename in the generated file.
 */
export function singularize(word: string): string {
  const lower = word.toLowerCase();
  if (UNCOUNTABLE.has(lower)) return word;

  const irregular = TO_SINGULAR.get(lower);
  if (irregular) return matchCase(word, irregular);

  // Words that end in `s` without being plural. Without this, `status` becomes
  // `Statu` and `address` becomes `Addres`, which is worse than doing nothing.
  if (/(ss|us|is)$/i.test(word)) return word;

  for (const [suffix, replacement] of [
    [/ies$/i, 'y'],
    [/(ch|sh|ss|x|z)es$/i, '$1'],
    // `statuses` and `buses` lose the doubled syllable; `houses` must not, so
    // the letter before `us` has to be a consonant for this to be a plural.
    [/([^aeiou]us)es$/i, '$1'],
    [/([^aeiou])oes$/i, '$1o'],
    [/s$/i, ''],
  ] as const) {
    if (suffix.test(word)) {
      const result = word.replace(suffix, replacement);
      // Never singularise a word down to nothing: a table called `s` keeps its
      // name rather than producing an entity with none.
      return result.length > 0 ? result : word;
    }
  }
  return word;
}

/**
 * A best guess at the plural of a word.
 *
 * A word that already looks plural is returned untouched, so pluralising
 * `users` does not produce `userses`. `address` is why that test is for a
 * single trailing `s`: a double one is part of the word rather than a plural.
 */
export function pluralize(word: string): string {
  const lower = word.toLowerCase();
  if (UNCOUNTABLE.has(lower)) return word;

  const irregular = TO_PLURAL.get(lower);
  if (irregular) return matchCase(word, irregular);
  if (TO_SINGULAR.has(lower)) return word;

  // Tested before the already-plural guard below, since every ending here is a
  // singular word that happens to end in `s`.
  if (/(ss|ch|sh|x|z|us)$/i.test(word)) return `${word}es`;
  if (/[^s]s$/i.test(word)) return word;
  if (/[^aeiou]y$/i.test(word)) return word.replace(/y$/i, 'ies');
  if (/[^aeiou]o$/i.test(word)) return `${word}es`;
  return `${word}s`;
}

/**
 * The entity name for a table: singular, PascalCase.
 *
 * Only the last word is singularised, so `order_items` becomes `OrderItem`
 * rather than losing the `s` in the middle of a compound name.
 */
export function entityName(table: string): string {
  const words = splitWords(table);
  if (words.length === 0) return pascalCase(table);
  const last = words[words.length - 1] as string;
  return pascalCase([...words.slice(0, -1), singularize(last)].join(' '));
}

/**
 * The property a table is reached through on the context.
 *
 * The physical name is used as written rather than pluralised: whether a table
 * is named `users` or `user` is the schema author's decision, and echoing it
 * makes the context key predictable from the table name alone.
 */
export function contextKey(table: string): string {
  return camelCase(table);
}

/**
 * The property name for a collection navigation back to a child table.
 *
 * This one does pluralise, because the property stands for many rows and reads
 * wrongly in the singular however the table was named.
 */
export function collectionName(childTable: string): string {
  const words = splitWords(childTable);
  if (words.length === 0) return camelCase(childTable);
  const last = words[words.length - 1] as string;
  return camelCase([...words.slice(0, -1), pluralize(last)].join(' '));
}

/**
 * The property name for a reference navigation, from the key that holds it.
 *
 * A foreign key is usually named after what it points at with `_id` on the end,
 * so dropping that suffix gives the better name: `city_id` becomes `city`,
 * which reads as the row rather than as the key. A key not named that way falls
 * back to the singular of the table it points at.
 */
export function referenceName(keyColumn: string, targetTable: string): string {
  const words = splitWords(keyColumn);
  const last = words[words.length - 1]?.toLowerCase();
  if (words.length > 1 && (last === 'id' || last === 'fk' || last === 'key')) {
    return camelCase(words.slice(0, -1).join(' '));
  }
  return camelCase(entityName(targetTable));
}

/**
 * Makes `candidate` unique against `taken`, and records it.
 *
 * Numbering a clash is deliberately dull. The alternative, inventing a longer
 * name out of the constraint or the table, reads as though the generator knew
 * something it does not, and a name it picked twice is exactly the case a human
 * should look at.
 */
export function unique(candidate: string, taken: Set<string>): string {
  let name = candidate;
  let suffix = 2;
  while (taken.has(name)) {
    name = `${candidate}${suffix}`;
    suffix += 1;
  }
  taken.add(name);
  return name;
}

/** A JavaScript identifier cannot start with a digit, so one gains a prefix. */
function safeIdentifier(name: string): string {
  return /^[0-9]/.test(name) ? `_${name}` : name;
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/** Applies the casing of the word we were given to the word we looked up. */
function matchCase(source: string, replacement: string): string {
  if (source === source.toUpperCase()) return replacement.toUpperCase();
  if (source.charAt(0) === source.charAt(0).toUpperCase()) return capitalize(replacement);
  return replacement;
}

/** `OrderItem` becomes `order-item`, which is the generated file's name. */
export function kebabCase(identifier: string): string {
  const words = splitWords(identifier);
  return words.length === 0 ? identifier : words.map((word) => word.toLowerCase()).join('-');
}
