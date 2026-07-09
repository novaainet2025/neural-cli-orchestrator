from typing import Dict
import unittest

def fib(n: int, memo: Dict[int, int] = None) -> int:
    """
    Calculates the nth Fibonacci number using recursion and memoization.
    fib(0) = 0, fib(1) = 1
    """
    if memo is None:
        memo = {0: 0, 1: 1}
    
    if n in memo:
        return memo[n]
    
    if n < 0:
        raise ValueError("n must be a non-negative integer")
        
    memo[n] = fib(n - 1, memo) + fib(n - 2, memo)
    return memo[n]

class TestFibonacci(unittest.TestCase):
    def test_base_cases(self):
        self.assertEqual(fib(0), 0)
        self.assertEqual(fib(1), 1)

    def test_values(self):
        self.assertEqual(fib(2), 1)
        self.assertEqual(fib(3), 2)
        self.assertEqual(fib(5), 5)
        self.assertEqual(fib(10), 55)
        self.assertEqual(fib(50), 12586269025)

if __name__ == "__main__":
    unittest.main()
