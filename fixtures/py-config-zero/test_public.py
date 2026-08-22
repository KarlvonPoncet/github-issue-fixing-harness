import unittest
from src.app import read_limit
class Public(unittest.TestCase):
    def test_zero(self): self.assertEqual(read_limit(0), 0)
if __name__ == "__main__": unittest.main()
