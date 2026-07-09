/**
 * Remove duplicates from an array of primitive values.
 * Works for string, number, boolean, symbol, null, undefined.
 * For objects, use removeDuplicatesByKey or provide a custom comparator.
 */
export function removeDuplicates<T extends string | number | boolean | symbol | null | undefined>(arr: T[]): T[] {
  return [...new Set(arr)];
}

/**
 * Remove duplicates from an array of objects based on a key selector.
 * @param arr Array of objects
 * @param keyFn Function that returns a unique key for each item
 * @returns New array with duplicates removed (first occurrence kept)
 */
export function removeDuplicatesByKey<T, K extends string | number | symbol>(arr: T[], keyFn: (item: T) => K): T[] {
  const seen = new Set<K>();
  const result: T[] = [];
  for (const item of arr) {
    const key = keyFn(item);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }
  return result;
}

/**
 * Remove duplicates from an array using a custom equality function.
 * @param arr Array of items
 * @param equals Function that returns true if two items are considered equal
 * @returns New array with duplicates removed (first occurrence kept)
 */
export function removeDuplicatesWith<T>(arr: T[], equals: (a: T, b: T) => boolean): T[] {
  const result: T[] = [];
  for (const item of arr) {
    if (!result.some(existing => equals(existing, item))) {
      result.push(item);
    }
  }
  return result;
}

// Example usage:
// const numbers = [1, 2, 2, 3, 4, 4, 5];
// console.log(removeDuplicates(numbers)); // [1, 2, 3, 4, 5]
//
// const users = [
//   { id: 1, name: 'Alice' },
//   { id: 2, name: 'Bob' },
//   { id: 1, name: 'Alice' },
//   { id: 3, name: 'Charlie' },
// ];
// console.log(removeDuplicatesByKey(users, u => u.id));
// // [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }, { id: 3, name: 'Charlie' }]
//
// const people = [
//   { name: 'Alice', age: 25 },
//   { name: 'Bob', age: 30 },
//   { name: 'Alice', age: 25 },
// ];
// console.log(removeDuplicatesWith(people, (a, b) => a.name === b.name && a.age === b.age));
// // [{ name: 'Alice', age: 25 }, { name: 'Bob', age: 30 }]