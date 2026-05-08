import unittest
from email.message import EmailMessage

from codex_relay.email_channel import parse_message


class EmailChannelTests(unittest.TestCase):
    def test_parse_plain_text_message(self):
        msg = EmailMessage()
        msg["From"] = "User <User@Example.com>"
        msg["Reply-To"] = "reply@example.com"
        msg["Subject"] = "codex: hello"
        msg["Message-ID"] = "<abc@example.com>"
        msg.set_content("body")

        parsed = parse_message("123", msg.as_bytes())

        self.assertEqual(parsed.uid, "123")
        self.assertEqual(parsed.sender, "user@example.com")
        self.assertEqual(parsed.reply_to, "reply@example.com")
        self.assertEqual(parsed.subject, "codex: hello")
        self.assertEqual(parsed.body.strip(), "body")
        self.assertEqual(parsed.message_id, "<abc@example.com>")


if __name__ == "__main__":
    unittest.main()

