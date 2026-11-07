# Classifier results (Role 2)

> **Status: not yet run on T-Mobile's dataset.** The dataset isn't in the repo yet, so there are
> no numbers here. This file is overwritten by `train.py --final`. Don't quote anything from a
> synthetic or test run.

To produce it (once, at the end):

```bash
python classifier/train.py --data /path/to/tmobile.csv --text-col <text column> --label-col <label column> \
  [--sender-col <sender column>] [--baseline-model /path/to/their_baseline.joblib] --final
```

It will contain:
- Baseline vs ours: per-class precision, recall and F1 on the held-out test split
- Confusion matrix for each model
- Recall on the 32-message toll/bank lure set (`data/lures_extra.csv`)
