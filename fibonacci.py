from __future__ import annotations
import unittest
from typing import Dict, Optional


def fib(n: int, memo: Optional[Dict[int, int]] = None) -> int:
    """
    Return the n-th Fibonacci number using recursion with memoization.
    - fib(0) = 0
    - fib(1) = 1
    Raises ValueError for negative n.
    """
    if memo is None:
        memo = {}
    if n < 0:
        raise ValueError("n must be a non-negative integer")
    if n in (0, 1):
        return n
    if n in memo:
        return memo[n]
    memo[n] = fib(n - 1, memo) + fib(n - 2, memo)
    return memo[n]


def fibonacci_sequence(n: int) -> list[int]:
    """
    Return the first n Fibonacci numbers as a list.
    - fibonacci_sequence(0) -> []
    - fibonacci_sequence(1) -> [0]
    - fibonacci_sequence(5) -> [0, 1, 1, 2, 3]
    Raises ValueError for negative n.
    """
    if n < 0:
        raise ValueError("n must be a non-negative integer")
    if n == 0:
        return []
    if n == 1:
        return [0]

    sequence = [0, 1]
    while len(sequence) < n:
        sequence.append(sequence[-1] + sequence[-2])
    return sequence


class TestFibonacci(unittest.TestCase):
    def test_base_cases(self):
        self.assertEqual(fib(0), 0)
        self.assertEqual(fib(1), 1)

    def test_first_ten(self):
        expected = [0, 1, 1, 2, 3, 5, 8, 13, 21, 34, 55]
        for i, exp in enumerate(expected):
            with self.subTest(i=i):
                self.assertEqual(fib(i), exp)

    def test_negative_input(self):
        with self.assertRaises(ValueError):
            fib(-1)

    def test_fibonacci_sequence_empty(self):
        self.assertEqual(fibonacci_sequence(0), [])

    def test_fibonacci_sequence_single(self):
        self.assertEqual(fibonacci_sequence(1), [0])

    def test_fibonacci_sequence_first_ten(self):
        self.assertEqual(
            fibonacci_sequence(10),
            [0, 1, 1, 2, 3, 5, 8, 13, 21, 34],
        )

    def test_fibonacci_sequence_matches_fib(self):
        for n in range(15):
            with self.subTest(n=n):
                self.assertEqual(fibonacci_sequence(n), [fib(i) for i in range(n)])

    def test_fibonacci_sequence_negative_input(self):
        with self.assertRaises(ValueError):
            fibonacci_sequence(-1)


if __name__ == "__main__":
    unittest.main()