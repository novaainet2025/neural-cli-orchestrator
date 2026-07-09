import { removeDuplicates, uniq } from '../src/utils/arrayUtils';

test('uniq removes duplicate numbers', () => {
  expect(uniq([1, 2, 2, 3, 1])).toEqual([1, 2, 3]);
});

test('uniq works with strings', () => {
  expect(uniq(['a', 'b', 'a', 'c'])).toEqual(['a', 'b', 'c']);
});

test('removeDuplicates removes duplicates while preserving order', () => {
  expect(removeDuplicates([1, 2, 2, 3, 1])).toEqual([1, 2, 3]);
  expect(removeDuplicates(['a', 'b', 'a', 'c'])).toEqual(['a', 'b', 'c']);
});
