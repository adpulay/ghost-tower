import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from features import (FEATURE_NAMES, detect_brand, extract_domains, handcrafted, is_alphanumeric_sender,  # noqa: E402
                      normalize_domain, rule_score, url_hash, with_sender)


class FeatureTests(unittest.TestCase):
    def test_brand_detection(self):
        self.assertEqual(detect_brand("TxTag: unpaid toll"), "TxTag")
        self.assertEqual(detect_brand("North Texas Tollway notice"), "NTTA")
        self.assertEqual(detect_brand("Your USPS package"), "USPS")
        self.assertEqual(detect_brand("chase alert"), "Chase")
        self.assertEqual(detect_brand("see you at lunch"), "")
        self.assertEqual(detect_brand("groups of people"), "")  # \bups\b must not match inside words

    def test_domains_and_hash_match_agent(self):
        self.assertEqual(extract_domains("Pay at https://www.TxTag-Pay-Demo.example/pay?x=1 now"), ["txtag-pay-demo.example"])
        self.assertEqual(extract_domains("Balance $4.35 due"), [])
        self.assertEqual(normalize_domain("HTTPS://www.usps.com:443/track"), "usps.com")
        # Same value as agent/src/knownDomains.ts urlHash("txtag-pay-demo.example")
        self.assertEqual(url_hash("txtag-pay-demo.example"), url_hash("www.TXTAG-pay-demo.example."))
        self.assertEqual(len(url_hash("x.example")), 64)

    def test_handcrafted_vector(self):
        v = dict(zip(FEATURE_NAMES, handcrafted(with_sender("TxTag: pay $4.35 today at txtag-pay.example", "TXTAG"))))
        self.assertEqual(v["has_url"], 1.0)
        self.assertEqual(v["toll_brand"], 1.0)
        self.assertEqual(v["money"], 1.0)
        self.assertEqual(v["alnum_sender"], 1.0)
        self.assertGreaterEqual(v["urgency_hits"], 1.0)
        self.assertTrue(is_alphanumeric_sender("TXTAG"))
        self.assertFalse(is_alphanumeric_sender("+12145550100"))

    def test_rule_score_orders_scam_above_ham(self):
        self.assertGreater(rule_score("TxTag: unpaid toll $4.35, pay today txtag-pay-demo.example"), 0.8)
        self.assertLess(rule_score("running late, see you at 6"), 0.2)


if __name__ == "__main__":
    unittest.main()
