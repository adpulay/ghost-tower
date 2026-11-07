# Classifier (Role 2): SMS scam score + brand

```bash
python3 -m venv classifier/.venv && classifier/.venv/bin/pip install -r classifier/requirements.txt
# dev: fit + tune on train/val only (the test split is created once, saved to splits/, and never touched)
classifier/.venv/bin/python classifier/train.py --data /path/tmobile.csv --text-col text --label-col label [--sender-col sender] [--baseline-model their.joblib]
# once, at the end: evaluate on test and write results.md (baseline vs ours, per-class P/R/F1, confusion matrices, lure recall)
classifier/.venv/bin/python classifier/train.py ... --final
# serve on the Brev box (INTERFACES.md §8)
classifier/.venv/bin/python classifier/server.py --port 8001
curl -s localhost:8001/score -d '{"text":"TxTag: unpaid toll $4.35, pay at txtag-pay-demo.example"}'   # → {"score": 0.9…, "brand": "TxTag"}
classifier/.venv/bin/python -m unittest discover -s classifier/tests
```

- **Baseline:** pass T-Mobile's model with `--baseline-model`. Without it, a word TF-IDF + LR
  stand-in is used and labelled as such in the results.
- **Ours:** word + character TF-IDF plus handcrafted features (brand keywords, link presence,
  shortener or suspicious TLD, urgency words, money, phone number, alphanumeric sender), with
  logistic regression. C is tuned on validation.
- **Brand detection:** `features.detect_brand` keyword map (TxTag, NTTA, USPS, Chase, …).
- **`/score` before a model exists:** it serves a rule-based fallback, so teammates aren't
  blocked. `GET /health` and the `X-Scorer` header show which scorer is active. Message text is
  never logged.
- `data/lures_extra.csv` holds 32 hand-written toll/bank lures with fictional `.example`
  domains (TESTING.md §2b).
- `url_hash` and domain normalization match `agent/src/knownDomains.ts`.
