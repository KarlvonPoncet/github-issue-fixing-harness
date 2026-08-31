import unittest
from src.app import word_counts
class Public(unittest.TestCase):
    def test_normalizes(self): self.assertEqual(word_counts("Hello, hello! world."), {"hello": 2, "world": 1})
if __name__ == "__main__": unittest.main()
