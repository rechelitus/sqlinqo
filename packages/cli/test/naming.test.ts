import { describe, expect, it } from 'vitest';
import {
  camelCase,
  collectionName,
  contextKey,
  entityName,
  kebabCase,
  pascalCase,
  pluralize,
  referenceName,
  singularize,
  splitWords,
  unique,
} from '../src/generate/naming.js';

describe('splitWords', () => {
  it('comes apart the same way whatever convention wrote the name', () => {
    expect(splitWords('user_id')).toEqual(['user', 'id']);
    expect(splitWords('userId')).toEqual(['user', 'Id']);
    expect(splitWords('user-id')).toEqual(['user', 'id']);
    expect(splitWords('  user  id ')).toEqual(['user', 'id']);
  });

  it('keeps a run of capitals as one word', () => {
    expect(splitWords('HTTPStatus')).toEqual(['HTTP', 'Status']);
    expect(splitWords('parseURL')).toEqual(['parse', 'URL']);
  });

  it('separates a digit from the letters after it', () => {
    expect(splitWords('address2Line')).toEqual(['address2', 'Line']);
  });
});

describe('camelCase and pascalCase', () => {
  it('rewrites a physical name into each convention', () => {
    expect(camelCase('city_id')).toBe('cityId');
    expect(camelCase('is_active')).toBe('isActive');
    expect(pascalCase('order_item')).toBe('OrderItem');
  });

  it('prefixes a leading digit rather than dropping it', () => {
    expect(camelCase('2fa_enabled')).toBe('_2faEnabled');
    expect(pascalCase('2fa_enabled')).toBe('_2faEnabled');
  });
});

describe('singularize', () => {
  it('handles the regular plurals', () => {
    expect(singularize('users')).toBe('user');
    expect(singularize('cities')).toBe('city');
    expect(singularize('addresses')).toBe('address');
    expect(singularize('boxes')).toBe('box');
  });

  it('knows the irregular ones', () => {
    expect(singularize('people')).toBe('person');
    expect(singularize('children')).toBe('child');
  });

  it('leaves a singular word that ends in s alone', () => {
    // Without this, `status` becomes `Statu`, which is the worst kind of wrong:
    // plausible enough to survive review.
    expect(singularize('status')).toBe('status');
    expect(singularize('address')).toBe('address');
    expect(singularize('analysis')).toBe('analysis');
  });

  it('splits a doubled syllable only where the plural really doubled it', () => {
    expect(singularize('statuses')).toBe('status');
    expect(singularize('buses')).toBe('bus');
    expect(singularize('houses')).toBe('house');
  });

  it('leaves an uncountable word untouched in both directions', () => {
    expect(singularize('series')).toBe('series');
    expect(pluralize('series')).toBe('series');
  });

  it('never reduces a word to nothing', () => {
    expect(singularize('s')).toBe('s');
  });
});

describe('pluralize', () => {
  it('handles the regular singulars', () => {
    expect(pluralize('user')).toBe('users');
    expect(pluralize('city')).toBe('cities');
    expect(pluralize('box')).toBe('boxes');
    expect(pluralize('address')).toBe('addresses');
    expect(pluralize('status')).toBe('statuses');
  });

  it('leaves a word that already looks plural alone', () => {
    expect(pluralize('users')).toBe('users');
    expect(pluralize('cities')).toBe('cities');
  });
});

describe('entityName', () => {
  it('singularises only the last word', () => {
    expect(entityName('users')).toBe('User');
    expect(entityName('order_items')).toBe('OrderItem');
    expect(entityName('cities')).toBe('City');
  });

  it('leaves a table already named in the singular alone', () => {
    expect(entityName('user')).toBe('User');
  });
});

describe('contextKey', () => {
  it('echoes the physical name rather than guessing at a number', () => {
    expect(contextKey('users')).toBe('users');
    expect(contextKey('order_item')).toBe('orderItem');
  });
});

describe('collectionName', () => {
  it('pluralises, since the property stands for many rows', () => {
    expect(collectionName('orders')).toBe('orders');
    expect(collectionName('order_item')).toBe('orderItems');
  });
});

describe('referenceName', () => {
  it('drops the key suffix so the property reads as the row', () => {
    expect(referenceName('city_id', 'cities')).toBe('city');
    expect(referenceName('shipping_address_id', 'addresses')).toBe('shippingAddress');
  });

  it('falls back to the target when the key is not named that way', () => {
    expect(referenceName('owner', 'users')).toBe('user');
    expect(referenceName('id', 'users')).toBe('user');
  });
});

describe('unique', () => {
  it('numbers a clash and records what it handed out', () => {
    const taken = new Set<string>();
    expect(unique('city', taken)).toBe('city');
    expect(unique('city', taken)).toBe('city2');
    expect(unique('city', taken)).toBe('city3');
    expect(taken).toEqual(new Set(['city', 'city2', 'city3']));
  });
});

describe('kebabCase', () => {
  it('names the file after the entity', () => {
    expect(kebabCase('OrderItem')).toBe('order-item');
    expect(kebabCase('User')).toBe('user');
  });
});
