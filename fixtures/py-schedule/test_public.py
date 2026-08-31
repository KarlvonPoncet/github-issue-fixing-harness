import unittest
from src.app import is_available
class Public(unittest.TestCase):
    def test_weekend(self): self.assertFalse(is_available("Saturday", []))
if __name__ == "__main__": unittest.main()
