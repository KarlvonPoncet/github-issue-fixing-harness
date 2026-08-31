import unittest
from src.app import summarize_log
class Public(unittest.TestCase):
    def test_levels(self): self.assertEqual(summarize_log(["INFO started", "error failed", "INFO done", "malformed"]), {"info":2,"error":1})
if __name__ == "__main__": unittest.main()
