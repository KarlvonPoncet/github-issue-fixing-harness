import unittest
from src.app import median_value
class Public(unittest.TestCase):
    def test_even(self): self.assertEqual(median_value([1, 4, 2, 8]), 3.0)
if __name__ == "__main__": unittest.main()
