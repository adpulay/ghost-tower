"""Tiny synthetic dataset for pipeline tests ONLY. Never report numbers from it."""

import csv
import random

SCAM = [
    "{b}: unpaid balance of ${a}. Pay today to avoid fees: {d}",
    "{b} alert: your account is locked. Verify now at {d}",
    "Final notice from {b}: outstanding amount ${a}. Visit {d} immediately",
    "{b}: delivery failed, update your address within 24 hours {d}",
]
HAM = [
    "Hey are we still on for lunch at {t}?",
    "Your {b} statement is ready. Log in to the app to view it.",
    "Running late, see you at {t}",
    "Reminder: dentist appointment tomorrow at {t}",
    "Thanks for paying your {b} bill. No action needed.",
    "Can you grab milk on the way home?",
]
BRANDS = ["TxTag", "NTTA", "USPS", "Chase", "PayPal", "Amazon"]


def write(path, n=240, seed=0):
    rng = random.Random(seed)
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["text", "label", "sender"])
        for i in range(n):
            b = rng.choice(BRANDS)
            if i % 3 == 0:
                t = rng.choice(SCAM).format(b=b, a=f"{rng.randint(1, 99)}.{rng.randint(10, 99)}", d=f"{b.lower()}-{rng.randint(1, 999)}.example")
                w.writerow([t, rng.choice(["spam", "smishing"]), b.upper()])
            else:
                t = rng.choice(HAM).format(b=b, t=f"{rng.randint(1, 12)}pm")
                w.writerow([t, "ham", f"+1214555{rng.randint(1000, 9999)}"])
