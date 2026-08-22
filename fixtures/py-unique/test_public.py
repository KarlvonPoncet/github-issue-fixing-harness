import unittest
from src.app import unique_values
class Public(unittest.TestCase):
    def test_order(self): self.assertEqual(unique_values(["b", "a", "b"]), ["b", "a"])
if __name__ == "__main__": unittest.main()
