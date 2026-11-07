"""Shared feature code for the Ghost Tower SMS scam classifier.

Imported by train.py (fitting) and server.py (serving), so a pickled pipeline that uses
HandcraftedFeatures loads in both. Domain normalization MUST match
agent/src/knownDomains.ts::normalizeDomain and the simulator, because url_hash is
SHA-256(normalized domain) everywhere (INTERFACES.md §2).
"""

from __future__ import annotations

import hashlib
import re

import numpy as np
from sklearn.base import BaseEstimator, TransformerMixin

# ---------------------------------------------------------------- brand detection

# Keyword map → canonical brand. Order matters: first match wins, so put specific names first.
BRANDS: list[tuple[str, list[str]]] = [
    ("TxTag", ["txtag", "tx tag"]),
    ("NTTA", ["ntta", "north texas tollway", "tolltag", "toll tag"]),
    ("E-ZPass", ["e-zpass", "ezpass", "e zpass"]),
    ("SunPass", ["sunpass"]),
    ("FasTrak", ["fastrak"]),
    ("USPS", ["usps", "postal service", "us post"]),
    ("FedEx", ["fedex"]),
    ("UPS", [r"\bups\b"]),
    ("DHL", [r"\bdhl\b"]),
    ("Chase", ["chase"]),
    ("Wells Fargo", ["wells fargo", "wellsfargo"]),
    ("Bank of America", ["bank of america", "bankofamerica", r"\bbofa\b"]),
    ("Capital One", ["capital one", "capitalone"]),
    ("Citi", [r"\bciti\b", "citibank"]),
    ("PayPal", ["paypal"]),
    ("Zelle", ["zelle"]),
    ("Venmo", ["venmo"]),
    ("Amazon", ["amazon"]),
    ("Apple", ["apple id", "icloud", r"\bapple\b"]),
    ("Netflix", ["netflix"]),
    ("IRS", [r"\birs\b", "internal revenue"]),
    ("DMV", [r"\bdmv\b", "department of motor"]),
    ("T-Mobile", ["t-mobile", "tmobile"]),
]
_BRAND_RES = [(b, re.compile("|".join(k if k.startswith(r"\b") else re.escape(k) for k in kws), re.I)) for b, kws in BRANDS]

TOLL_BRANDS = {"TxTag", "NTTA", "E-ZPass", "SunPass", "FasTrak"}


def detect_brand(text: str) -> str:
    """Impersonated brand guess, "" if none (INTERFACES.md anomaly_event.brand)."""
    for brand, rx in _BRAND_RES:
        if rx.search(text or ""):
            return brand
    return ""


# ---------------------------------------------------------------- links

URL_RE = re.compile(
    r"(?:(?:https?://)?(?:www\.)?)((?:[a-z0-9-]+\.)+(?:[a-z]{2,24}))(?::\d+)?(?:[/?#][^\s]*)?",
    re.I,
)
SHORTENERS = {"bit.ly", "tinyurl.com", "t.co", "goo.gl", "ow.ly", "is.gd", "rb.gy", "cutt.ly", "shorturl.at", "tiny.cc"}
SUSPICIOUS_TLDS = {"top", "xyz", "icu", "cc", "vip", "shop", "click", "live", "info", "buzz", "cfd", "sbs", "rest", "lol", "online", "site", "win", "example"}
_NOT_DOMAINS = re.compile(r"^\d+(\.\d+)+$")  # amounts like 4.35


def normalize_domain(d: str) -> str:
    d = d.strip().lower()
    d = re.sub(r"^[a-z]+://", "", d)
    d = re.split(r"[/?#]", d)[0]
    d = re.sub(r":\d+$", "", d)
    d = re.sub(r"^www\.", "", d)
    return d.rstrip(".")


def extract_domains(text: str) -> list[str]:
    out = []
    for m in URL_RE.finditer(text or ""):
        dom = normalize_domain(m.group(1))
        if _NOT_DOMAINS.match(dom):
            continue
        out.append(dom)
    return out


def url_hash(domain: str) -> str:
    return hashlib.sha256(normalize_domain(domain).encode()).hexdigest()


# ---------------------------------------------------------------- handcrafted features

URGENCY = re.compile(
    r"\b(urgent|immediately|final notice|last notice|act now|today|within 24|24 hours|48 hours|suspend|suspended|"
    r"overdue|unpaid|outstanding|penalt(y|ies)|late fee|avoid|expire[sd]?|locked|verify|confirm|restricted|deadline)\b",
    re.I,
)
MONEY = re.compile(r"(\$\s?\d|\d+\.\d{2}\b|\busd\b)", re.I)
PHONE = re.compile(r"\+?1?[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}")
SENDER_TAG = re.compile(r"^<<sender:([^>]*)>>\s*")


def with_sender(text: str, sender: str | None) -> str:
    """Encode an optional sender ID into the model input string."""
    return f"<<sender:{sender}>> {text}" if sender else text


def split_sender(x: str) -> tuple[str, str]:
    m = SENDER_TAG.match(x)
    return (m.group(1), x[m.end():]) if m else ("", x)


def is_alphanumeric_sender(sender: str) -> bool:
    """Alphanumeric sender IDs (e.g. 'TXTAG') instead of a phone number / short code."""
    s = sender.strip()
    return bool(s) and bool(re.search(r"[A-Za-z]", s)) and not s.startswith("+")


FEATURE_NAMES = [
    "has_url", "n_urls", "shortener", "suspicious_tld", "brand", "toll_brand", "urgency_hits",
    "money", "phone_number", "alnum_sender", "len_log", "upper_ratio", "digit_ratio", "brand_and_url",
]


def handcrafted(x: str) -> list[float]:
    sender, text = split_sender(x)
    doms = extract_domains(text)
    brand = detect_brand(text)
    tlds = {d.rsplit(".", 1)[-1] for d in doms}
    letters = [c for c in text if c.isalpha()]
    n = max(1, len(text))
    return [
        float(bool(doms)),
        float(min(len(doms), 3)),
        float(any(d in SHORTENERS for d in doms)),
        float(bool(tlds & SUSPICIOUS_TLDS)),
        float(bool(brand)),
        float(brand in TOLL_BRANDS),
        float(min(len(URGENCY.findall(text)), 4)),
        float(bool(MONEY.search(text))),
        float(bool(PHONE.search(text))),
        float(is_alphanumeric_sender(sender)),
        float(np.log1p(len(text))),
        (sum(c.isupper() for c in letters) / len(letters)) if letters else 0.0,
        sum(c.isdigit() for c in text) / n,
        float(bool(brand) and bool(doms)),
    ]


class HandcraftedFeatures(BaseEstimator, TransformerMixin):
    """sklearn transformer: list[str] → dense matrix of FEATURE_NAMES."""

    def fit(self, X, y=None):  # noqa: N803
        return self

    def transform(self, X):  # noqa: N803
        return np.array([handcrafted(x) for x in X], dtype=float)

    def get_feature_names_out(self, input_features=None):
        return np.array(FEATURE_NAMES)


def rule_score(text: str) -> float:
    """Model-free fallback score in [0, 1], used by /score until a trained model exists."""
    f = dict(zip(FEATURE_NAMES, handcrafted(text)))
    z = (
        -3.0
        + 2.0 * f["has_url"]
        + 1.2 * f["suspicious_tld"]
        + 1.0 * f["shortener"]
        + 1.2 * f["brand"]
        + 0.6 * f["toll_brand"]
        + 0.7 * f["urgency_hits"]
        + 0.8 * f["money"]
        + 0.8 * f["brand_and_url"]
    )
    return float(1 / (1 + np.exp(-z)))
