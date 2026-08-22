import unittest
from src.app import format_contact
class Public(unittest.TestCase):
    def test_email(self): self.assertEqual(format_contact("Ada", "ada@example.test"), "Ada <ada@example.test>")
if __name__ == "__main__": unittest.main()
