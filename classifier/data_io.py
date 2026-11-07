"""Dataset loading and the fixed, seeded train/validation/test split."""

from __future__ import annotations

import csv
import json
import random
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

from features import with_sender

# Labels treated as "scam" for the binary /score probability. Anything else is benign.
DEFAULT_POSITIVE = {"spam", "smishing", "scam", "phishing", "fraud", "1", "true", "yes"}


@dataclass
class Dataset:
    X: list[str]          # model input (text, optionally with encoded sender)
    labels: list[str]     # original class names (kept for per-class metrics)
    y: list[int]          # 1 = scam, 0 = benign


def load(path: str | Path, text_col: str, label_col: str, sender_col: str | None = None,
         positive: set[str] | None = None) -> Dataset:
    path = Path(path)
    positive = {p.lower() for p in (positive or DEFAULT_POSITIVE)}
    delim = "\t" if path.suffix.lower() in {".tsv", ".txt"} else ","
    X, labels, y = [], [], []
    with path.open(newline="", encoding="utf-8", errors="replace") as f:
        for row in csv.DictReader(f, delimiter=delim):
            text = (row.get(text_col) or "").strip()
            label = (row.get(label_col) or "").strip().lower()
            if not text or not label:
                continue
            sender = (row.get(sender_col) or "").strip() if sender_col else None
            X.append(with_sender(text, sender))
            labels.append(label)
            y.append(int(label in positive))
    if not X:
        raise ValueError(f"no rows loaded from {path} (columns {text_col!r}/{label_col!r})")
    return Dataset(X, labels, y)


def split_indices(labels: list[str], seed: int = 42, val: float = 0.15, test: float = 0.15) -> dict[str, list[int]]:
    """Stratified by original label, deterministic for a given seed."""
    rng = random.Random(seed)
    by_label: dict[str, list[int]] = defaultdict(list)
    for i, lab in enumerate(labels):
        by_label[lab].append(i)
    out = {"train": [], "val": [], "test": []}
    for lab in sorted(by_label):
        idx = by_label[lab][:]
        rng.shuffle(idx)
        n_test = max(1, round(len(idx) * test)) if len(idx) >= 3 else 0
        n_val = max(1, round(len(idx) * val)) if len(idx) >= 3 else 0
        out["test"] += idx[:n_test]
        out["val"] += idx[n_test:n_test + n_val]
        out["train"] += idx[n_test + n_val:]
    for k in out:
        out[k].sort()
    return out


def load_or_create_split(split_file: Path, labels: list[str], seed: int) -> dict[str, list[int]]:
    """The split is written once and reused, so the test set never changes between runs."""
    if split_file.exists():
        s = json.loads(split_file.read_text())
        if s.get("n") == len(labels) and s.get("seed") == seed:
            return s["idx"]
        raise SystemExit(f"{split_file} was made for a different dataset/seed; delete it deliberately to re-split")
    idx = split_indices(labels, seed)
    split_file.parent.mkdir(parents=True, exist_ok=True)
    split_file.write_text(json.dumps({"seed": seed, "n": len(labels), "idx": idx}))
    return idx


def take(ds: Dataset, idx: list[int]) -> Dataset:
    return Dataset([ds.X[i] for i in idx], [ds.labels[i] for i in idx], [ds.y[i] for i in idx])
