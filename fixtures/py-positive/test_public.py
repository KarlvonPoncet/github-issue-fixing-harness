import unittest
from src.app import parse_positive
class Public(unittest.TestCase):
    def test_zero(self):
        with self.assertRaises(ValueError): parse_positive("0")
if __name__ == "__main__": unittest.main()
