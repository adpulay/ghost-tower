"""Train and evaluate the Ghost Tower SMS scam classifier against T-Mobile's baseline.

    python classifier/train.py --data path/to/tmobile.csv --text-col text --label-col label \
        [--sender-col sender] [--baseline-model their_model.joblib]          # dev: val metrics only
    python classifier/train.py ... --final                                   # once: test metrics → results.md

The seeded split is saved to classifier/splits/ the first time and reused forever, so the
test set is never seen during development. Only run --final at the end.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
import time
from pathlib import Path

import joblib
import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import confusion_matrix, precision_recall_fscore_support
from sklearn.pipeline import FeatureUnion, Pipeline
from sklearn.preprocessing import StandardScaler

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from data_io import Dataset, load, load_or_create_split, take  # noqa: E402
from features import HandcraftedFeatures, split_sender  # noqa: E402

CLASS_NAMES = ["benign", "scam"]


def raw_text(X: list[str]) -> list[str]:
    return [split_sender(x)[1] for x in X]


# ---------------------------------------------------------------- models

def reproduced_baseline(C: float = 1.0) -> Pipeline:
    """Stand-in for T-Mobile's baseline when their model file isn't provided: word TF-IDF + LR.
    Replace with their exact model via --baseline-model as soon as it's available."""
    return Pipeline([
        ("tfidf", TfidfVectorizer(lowercase=True, ngram_range=(1, 1), min_df=1)),
        ("lr", LogisticRegression(C=C, max_iter=2000)),
    ])


def improved(C: float) -> Pipeline:
    feats = FeatureUnion([
        ("word", TfidfVectorizer(lowercase=True, ngram_range=(1, 2), min_df=1, sublinear_tf=True)),
        ("char", TfidfVectorizer(lowercase=True, analyzer="char_wb", ngram_range=(2, 5), min_df=2, sublinear_tf=True)),
        ("hand", Pipeline([("f", HandcraftedFeatures()), ("scale", StandardScaler())])),
    ])
    return Pipeline([("features", feats), ("lr", LogisticRegression(C=C, max_iter=4000, class_weight="balanced"))])


class ExternalBaseline:
    """Wraps T-Mobile's provided model (anything joblib-loadable with predict / predict_proba on raw text)."""

    def __init__(self, path: str, positive: set[str]):
        self.m = joblib.load(path)
        self.positive = positive

    def predict(self, X: list[str]) -> np.ndarray:
        pred = self.m.predict(raw_text(X))
        return np.array([int(str(p).strip().lower() in self.positive or p == 1) for p in pred])


# ---------------------------------------------------------------- metrics

def metrics(y_true: list[int], y_pred, labels_orig: list[str] | None = None) -> dict:
    p, r, f, s = precision_recall_fscore_support(y_true, y_pred, labels=[0, 1], zero_division=0)
    cm = confusion_matrix(y_true, y_pred, labels=[0, 1]).tolist()
    out = {
        "per_class": {CLASS_NAMES[i]: {"precision": p[i], "recall": r[i], "f1": f[i], "support": int(s[i])} for i in range(2)},
        "confusion": cm,
    }
    if labels_orig:
        by = {}
        for lab in sorted(set(labels_orig)):
            idx = [i for i, l in enumerate(labels_orig) if l == lab]
            by[lab] = {"n": len(idx), "flagged_scam": float(np.mean([y_pred[i] for i in idx]))}
        out["by_original_label"] = by
    return out


def fmt_table(name_to_m: dict[str, dict]) -> str:
    rows = ["| Model | Class | Precision | Recall | F1 | Support |", "|---|---|---|---|---|---|"]
    for name, m in name_to_m.items():
        for cls in CLASS_NAMES:
            c = m["per_class"][cls]
            rows.append(f"| {name} | {cls} | {c['precision']:.3f} | {c['recall']:.3f} | {c['f1']:.3f} | {c['support']} |")
    return "\n".join(rows)


def fmt_cm(name: str, cm: list[list[int]]) -> str:
    return "\n".join([
        f"**{name}** (rows = true, cols = predicted)",
        "",
        "| | pred benign | pred scam |",
        "|---|---|---|",
        f"| **true benign** | {cm[0][0]} | {cm[0][1]} |",
        f"| **true scam** | {cm[1][0]} | {cm[1][1]} |",
    ])


# ---------------------------------------------------------------- main

def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--text-col", default="text")
    ap.add_argument("--label-col", default="label")
    ap.add_argument("--sender-col", default=None)
    ap.add_argument("--positive", default=None, help="comma-separated labels counted as scam")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--baseline-model", default=None, help="T-Mobile's provided baseline (joblib)")
    ap.add_argument("--lures", default=str(HERE / "data" / "lures_extra.csv"))
    ap.add_argument("--final", action="store_true", help="evaluate on the held-out TEST split and write results.md")
    ap.add_argument("--split-file", default=None)
    ap.add_argument("--model-out", default=str(HERE / "model" / "model.joblib"))
    ap.add_argument("--results", default=str(HERE / "results.md"))
    a = ap.parse_args(argv)

    positive = set(a.positive.lower().split(",")) if a.positive else None
    ds = load(a.data, a.text_col, a.label_col, a.sender_col, positive)
    split_file = Path(a.split_file) if a.split_file else HERE / "splits" / f"{Path(a.data).stem}.seed{a.seed}.json"
    idx = load_or_create_split(split_file, ds.labels, a.seed)
    tr, va, te = take(ds, idx["train"]), take(ds, idx["val"]), take(ds, idx["test"])
    print(f"loaded {len(ds.X)} rows ({sum(ds.y)} scam); split train={len(tr.X)} val={len(va.X)} test={len(te.X)} → {split_file}")

    # Baseline
    if a.baseline_model:
        baseline = ExternalBaseline(a.baseline_model, positive or {"spam", "smishing", "scam", "1"})
        baseline_name = f"T-Mobile baseline ({Path(a.baseline_model).name})"
    else:
        baseline = reproduced_baseline().fit(raw_text(tr.X), tr.y)
        baseline_name = "Baseline (reproduced: word TF-IDF + LR)"

    # Improved: tune C on validation only.
    t0 = time.time()
    best = None
    for C in [0.5, 1, 2, 4, 8, 16]:
        m = improved(C).fit(tr.X, tr.y)
        f1 = metrics(va.y, m.predict(va.X))["per_class"]["scam"]["f1"]
        print(f"  C={C:<4} val scam-F1={f1:.4f}")
        if best is None or f1 > best[0]:
            best = (f1, C)
    C = best[1]
    # Refit on train+val for the final model (test still untouched).
    trva = Dataset(tr.X + va.X, tr.labels + va.labels, tr.y + va.y)
    model = improved(C).fit(trva.X, trva.y)
    print(f"chose C={C} in {time.time() - t0:.1f}s")
    Path(a.model_out).parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(model, a.model_out)
    print(f"saved {a.model_out}")

    bpred_va = baseline.predict(va.X if a.baseline_model else raw_text(va.X))
    print("\nVALIDATION (baseline fit on train; ours tuned on val, refit on train+val so val is optimistic for ours)")
    print(fmt_table({baseline_name: metrics(va.y, bpred_va), "Ours": metrics(va.y, model.predict(va.X))}))

    if not a.final:
        print("\n(dev run: test split untouched. Re-run with --final once, at the end.)")
        return

    eval_set = te
    bpred = baseline.predict(eval_set.X if a.baseline_model else raw_text(eval_set.X))
    opred = model.predict(eval_set.X)
    mb, mo = metrics(eval_set.y, bpred, eval_set.labels), metrics(eval_set.y, opred, eval_set.labels)

    lures_md = "_No lure set found._"
    if Path(a.lures).exists():
        lu = load(a.lures, "text", "label")
        lb = baseline.predict(lu.X if a.baseline_model else raw_text(lu.X))
        lo = model.predict(lu.X)
        n = sum(lu.y)
        lures_md = (
            f"{n} hand-written toll/bank lures (`{Path(a.lures).name}`, fictional `.example` domains), recall:\n\n"
            f"| Model | Recall |\n|---|---|\n"
            f"| {baseline_name} | {np.mean([p for p, t in zip(lb, lu.y) if t]):.3f} |\n"
            f"| Ours | {np.mean([p for p, t in zip(lo, lu.y) if t]):.3f} |"
        )

    by_label = ""
    if len(set(eval_set.labels)) > 2:
        rows = ["| Original label | n | Baseline flagged as scam | Ours flagged as scam |", "|---|---|---|---|"]
        for lab, v in mo["by_original_label"].items():
            rows.append(f"| {lab} | {v['n']} | {mb['by_original_label'][lab]['flagged_scam']:.3f} | {v['flagged_scam']:.3f} |")
        by_label = "\n### Per original class\n\n" + "\n".join(rows) + "\n"

    d_f1 = mo["per_class"]["scam"]["f1"] - mb["per_class"]["scam"]["f1"]
    md = f"""# Classifier results (Role 2)

- Generated: {dt.datetime.now().isoformat(timespec='seconds')}
- Data: `{Path(a.data).name}`, {len(ds.X)} rows; seeded stratified split (seed {a.seed}) saved to `{split_file.relative_to(HERE) if split_file.is_relative_to(HERE) else split_file}`
- Evaluated **once** on the held-out test split ({len(te.X)} rows), never used for training or tuning.
- Ours: word 1–2-gram TF-IDF + char 2–5-gram TF-IDF + handcrafted features (brand keywords, link presence, shortener / suspicious TLD, urgency words, money, phone number, alphanumeric sender), logistic regression, C={C} chosen on validation.

## Headline

Scam-class F1: **{mb['per_class']['scam']['f1']:.3f} → {mo['per_class']['scam']['f1']:.3f}** ({d_f1:+.3f}) vs {baseline_name}.

## Per-class precision / recall / F1 (test)

{fmt_table({baseline_name: mb, "Ours": mo})}

## Confusion matrices (test)

{fmt_cm(baseline_name, mb['confusion'])}

{fmt_cm("Ours", mo['confusion'])}
{by_label}
## Toll / bank lure set

{lures_md}
"""
    Path(a.results).write_text(md)
    Path(a.results).with_suffix(".json").write_text(json.dumps({"baseline": mb, "ours": mo, "C": C}, indent=2, default=float))
    print(f"\nwrote {a.results}")


if __name__ == "__main__":
    main()
