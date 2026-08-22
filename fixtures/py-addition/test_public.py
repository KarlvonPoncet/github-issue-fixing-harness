import unittest
from src.app import add
class Public(unittest.TestCase):
    def test_add(self): self.assertEqual(add(4, 2), 6)
if __name__ == "__main__": unittest.main()
