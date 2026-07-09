import { removeDuplicates, removeDuplicatesByKey, removeDuplicatesWith } from './removeDuplicates';

// Test primitive duplicates
const numbers = [1, 2, 2, 3, 4, 4, 5];
console.log('Original numbers:', numbers);
console.log('After removeDuplicates:', removeDuplicates(numbers)); // [1,2,3,4,5]

const strings = ['a', 'b', 'a', 'c', 'b'];
console.log('Original strings:', strings);
console.log('After removeDuplicates:', removeDuplicates(strings)); // ['a','b','c']

// Test object deduplication by key
const users = [
  { id: 1, name: 'Alice' },
  { id: 2, name: 'Bob' },
  { id: 1, name: 'Alice' },
  { id: 3, name: 'Charlie' },
];
console.log('Original users:', users);
console.log('After removeDuplicatesByKey (id):', removeDuplicatesByKey(users, u => u.id));
// Expected: [{id:1,name:'Alice'},{id:2,name:'Bob'},{id:3,name:'Charlie'}]

// Test object deduplication with custom equals
const people = [
  { name: 'Alice', age: 25 },
  { name: 'Bob', age: 30 },
  { name: 'Alice', age: 25 },
];
console.log('Original people:', people);
console.log('After removeDuplicatesWith (name+age):', removeDuplicatesWith(people, (a, b) => a.name === b.name && a.age === b.age));
// Expected: [{name:'Alice',age:25},{name:'Bob',age:30}]