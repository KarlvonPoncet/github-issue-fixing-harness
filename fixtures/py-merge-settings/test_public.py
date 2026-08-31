import unittest
from src.app import merge_settings
class Public(unittest.TestCase):
    def test_nested(self): self.assertEqual(merge_settings({"retry":{"count":2,"delay":1},"region":"us"}, {"retry":{"count":0}}), {"retry":{"count":0,"delay":1},"region":"us"})
if __name__ == "__main__": unittest.main()
