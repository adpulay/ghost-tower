"""Run with: python -m unittest agent.tools.draft_report.test_draft_report (from repo root)
or:        python -m unittest discover -s agent/tools/draft_report
"""
import unittest

try:
    from .draft_report import KINDS, TrackContext, draft_report, validate_warning
except ImportError:  # discover mode
    from draft_report import KINDS, TrackContext, draft_report, validate_warning

CTX = TrackContext(
    track_id=1,
    lat=32.9856,
    lon=-96.7500,
    heading_deg=90,
    speed_mps=13.4,
    intercept_lat=32.9856,
    intercept_lon=-96.7400,
    eta_s=75,
    brand="TxTag",
    domain="txtag-pay-now.example",
    domain_age_days=3,
    first_seen_iso="2026-11-07T20:14:00Z",
    area="Campbell Rd in Richardson",
)
loader = lambda _id: CTX  # noqa: E731


def boom(_prompt):
    raise RuntimeError("model down")


class DraftReportTests(unittest.TestCase):
    def test_warning_good_output_passes_through(self):
        msg = "Fake cell tower near Campbell Rd. Texts claiming to be TxTag are scams. Don't tap links."
        out = draft_report(1, "warning", context_loader=loader, llm=lambda p: msg)
        self.assertEqual(out["text"], msg)

    def test_warning_too_long_falls_back(self):
        out = draft_report(1, "warning", context_loader=loader, llm=lambda p: "x" * 200)
        self.assertTrue(validate_warning(out["text"]))
        self.assertIn("TxTag", out["text"])

    def test_warning_with_url_falls_back(self):
        out = draft_report(1, "warning", context_loader=loader,
                           llm=lambda p: "Scam TxTag texts nearby, check https://txtag.org/real")
        self.assertTrue(validate_warning(out["text"]))
        self.assertNotIn("http", out["text"])

    def test_warning_bare_domain_falls_back(self):
        out = draft_report(1, "warning", context_loader=loader,
                           llm=lambda p: "Do not visit txtag-pay-now.com, it is a scam.")
        self.assertNotIn(".com", out["text"])

    def test_warning_fallback_always_valid_20_runs(self):
        for i in range(20):
            llm = (lambda p: "y" * 300) if i % 2 else boom
            out = draft_report(1, "warning", context_loader=loader, llm=llm)
            self.assertTrue(validate_warning(out["text"]), out["text"])

    def test_police_fallback_has_required_facts(self):
        out = draft_report(1, "police", context_loader=loader, llm=boom)["text"]
        self.assertLessEqual(len(out.splitlines()), 5)
        for needle in ("32.9856", "east", "32.9856, -96.7400", "TxTag"):
            self.assertIn(needle, out)

    def test_police_too_many_lines_falls_back(self):
        out = draft_report(1, "police", context_loader=loader, llm=lambda p: "a\nb\nc\nd\ne\nf\ng")["text"]
        self.assertLessEqual(len(out.splitlines()), 5)

    def test_registrar_names_domain_and_brand(self):
        out = draft_report(1, "registrar", context_loader=loader, llm=boom)["text"]
        self.assertIn("txtag-pay-now.example", out)
        self.assertIn("TxTag", out)
        self.assertIn("suspended", out)

    def test_registrar_missing_domain_in_llm_output_falls_back(self):
        out = draft_report(1, "registrar", context_loader=loader, llm=lambda p: "Please act.")["text"]
        self.assertIn("txtag-pay-now.example", out)

    def test_prompts_render_for_every_kind(self):
        seen = []
        for k in KINDS:
            draft_report(1, k, context_loader=loader, llm=lambda p: seen.append(p) or "x")
        self.assertEqual(len(seen), 3)
        self.assertTrue(all("{" not in p for p in seen))

    def test_unknown_kind_rejected(self):
        with self.assertRaises(ValueError):
            draft_report(1, "tweet", context_loader=loader, llm=boom)


if __name__ == "__main__":
    unittest.main()
