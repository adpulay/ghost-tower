import json
import sys
import tempfile
import threading
import unittest
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import synthetic  # noqa: E402
import train  # noqa: E402
from data_io import load, split_indices  # noqa: E402
from server import serve  # noqa: E402


class PipelineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp())
        cls.data = cls.tmp / "synthetic.csv"
        synthetic.write(cls.data)

    def test_split_is_seeded_stratified_and_disjoint(self):
        ds = load(self.data, "text", "label", "sender")
        a, b = split_indices(ds.labels, 42), split_indices(ds.labels, 42)
        self.assertEqual(a, b)
        self.assertNotEqual(a, split_indices(ds.labels, 7))
        sets = [set(a[k]) for k in ("train", "val", "test")]
        self.assertFalse(sets[0] & sets[1] or sets[0] & sets[2] or sets[1] & sets[2])
        self.assertEqual(sum(len(s) for s in sets), len(ds.labels))
        for k in ("val", "test"):
            labs = {ds.labels[i] for i in a[k]}
            self.assertEqual(labs, {"ham", "spam", "smishing"})

    def test_train_final_writes_results_and_model_then_server_scores(self):
        model = self.tmp / "m.joblib"
        results = self.tmp / "results.md"
        train.main([
            "--data", str(self.data), "--sender-col", "sender", "--final",
            "--split-file", str(self.tmp / "split.json"), "--model-out", str(model), "--results", str(results),
        ])
        md = results.read_text()
        for needle in ["Per-class precision / recall / F1", "Confusion matrices", "Ours", "Baseline", "Toll / bank lure set"]:
            self.assertIn(needle, md)
        self.assertTrue(model.exists())

        httpd, scorer = serve("127.0.0.1", 0, model)
        self.assertTrue(scorer.name.startswith("model:"))
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        try:
            port = httpd.server_address[1]
            req = urllib.request.Request(
                f"http://127.0.0.1:{port}/score",
                data=json.dumps({"text": "TxTag: unpaid toll $4.35, pay today at txtag-pay-demo.example"}).encode(),
                headers={"Content-Type": "application/json"},
            )
            body = json.loads(urllib.request.urlopen(req).read())
            self.assertEqual(set(body), {"score", "brand"})
            self.assertEqual(body["brand"], "TxTag")
            self.assertGreater(body["score"], 0.5)
        finally:
            httpd.shutdown()

    def test_server_rules_fallback_and_bad_input(self):
        httpd, scorer = serve("127.0.0.1", 0, None)
        self.assertEqual(scorer.name, "rules")
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        try:
            port = httpd.server_address[1]
            req = urllib.request.Request(f"http://127.0.0.1:{port}/score", data=b'{"nope": 1}', headers={"Content-Type": "application/json"})
            with self.assertRaises(urllib.error.HTTPError) as cm:
                urllib.request.urlopen(req)
            self.assertEqual(cm.exception.code, 400)
            health = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{port}/health").read())
            self.assertEqual(health["scorer"], "rules")
        finally:
            httpd.shutdown()


if __name__ == "__main__":
    unittest.main()
