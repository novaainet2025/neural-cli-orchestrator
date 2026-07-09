from __future__ import annotations

import unittest

from add import add


class TestAdd(unittest.TestCase):
    def test_add_integers(self) -> None:
        self.assertEqual(add(1, 2), 3)

    def test_add_floats(self) -> None:
        self.assertEqual(add(1.5, 2.5), 4.0)

    def test_add_negative_numbers(self) -> None:
        self.assertEqual(add(-3, 1), -2)


if __name__ == "__main__":
    unittest.main()
