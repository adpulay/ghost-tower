"""Generate report text with Nemotron, with hard checks and fixed-template fallbacks.

The LLM only writes words. Facts (position, heading, brand, domain age) come from the
track/campaign rows and are passed into the prompt; the hard checks below decide what
is allowed to leave this function.

Config (same Nemotron endpoint as Role 2, OpenAI-compatible chat completions):
    NEMOTRON_URL    e.g. http://<brev-host>:8000/v1
    NEMOTRON_MODEL  model name served at that URL
    NEMOTRON_API_KEY  optional
If NEMOTRON_URL is unset or the call fails, the fixed template is returned.
"""
from __future__ import annotations

import json
import os
import re
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional

PROMPT_DIR = Path(__file__).parent / "prompts"
KINDS = ("warning", "police", "registrar")
WARNING_MAX_CHARS = 160
POLICE_MAX_LINES = 5

# Anything that looks like a link or bare domain.
_URL_RE = re.compile(
    r"(https?://|www\.|\b[a-z0-9-]+\.(?:com|net|org|io|co|info|xyz|top|link|app|us|ly)\b)",
    re.IGNORECASE,
)


@dataclass
class TrackContext:
    track_id: int
    lat: float
    lon: float
    heading_deg: float
    speed_mps: float
    intercept_lat: Optional[float] = None
    intercept_lon: Optional[float] = None
    eta_s: Optional[int] = None
    brand: str = ""
    domain: str = ""
    domain_age_days: int = -1
    first_seen_iso: str = ""
    area: str = "the Richardson area"
    evidence: str = ""


# Role 2 wires this to Spacetime (get_track_context). Tests pass a fixed context instead.
ContextLoader = Callable[[int], TrackContext]
LlmCall = Callable[[str], str]


def _compass(deg: float) -> str:
    names = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"]
    return names[int(((deg % 360) + 22.5) // 45) % 8]


def _age(days: int) -> str:
    return "unknown" if days < 0 else f"{days} days"


def validate_warning(text: str) -> bool:
    return 0 < len(text) <= WARNING_MAX_CHARS and not _URL_RE.search(text)


def validate_police(text: str) -> bool:
    lines = [ln for ln in text.strip().splitlines() if ln.strip()]
    return 0 < len(lines) <= POLICE_MAX_LINES


def validate_registrar(text: str, ctx: TrackContext) -> bool:
    t = text.lower()
    has_domain = (not ctx.domain) or ctx.domain.lower() in t
    has_brand = (not ctx.brand) or ctx.brand.lower() in t
    return bool(text.strip()) and has_domain and has_brand


def fallback_text(kind: str, ctx: TrackContext) -> str:
    brand = ctx.brand or "a known brand"
    if kind == "warning":
        text = (
            f"Fake cell tower near {ctx.area}. Texts claiming to be {brand} are scams. "
            "Do not tap any links."
        )
        if len(text) > WARNING_MAX_CHARS:
            text = f"Fake cell tower nearby. Texts claiming to be {brand} are scams. Do not tap links."
        return text[:WARNING_MAX_CHARS]
    if kind == "police":
        lines = [
            f"SMS blaster track {ctx.track_id}: {ctx.lat:.4f}, {ctx.lon:.4f}.",
            f"Heading {_compass(ctx.heading_deg)} ({ctx.heading_deg:.0f} deg) at {ctx.speed_mps * 2.237:.0f} mph.",
        ]
        if ctx.intercept_lat is not None and ctx.intercept_lon is not None:
            eta = f", ETA {ctx.eta_s}s" if ctx.eta_s is not None else ""
            lines.append(f"Suggested intercept: {ctx.intercept_lat:.4f}, {ctx.intercept_lon:.4f}{eta}.")
        lines.append(f"Campaign: {brand} lure. Domain age: {_age(ctx.domain_age_days)}.")
        return "\n".join(lines[:POLICE_MAX_LINES])
    if kind == "registrar":
        domain = ctx.domain or "[domain withheld]"
        return (
            f"Abuse report: the domain {domain} is being used in a phishing campaign "
            f"impersonating {brand}. First seen: {ctx.first_seen_iso or 'unknown'}. "
            f"Domain age: {_age(ctx.domain_age_days)}. Evidence: {ctx.evidence or 'text messages delivered through a suspected fake cell site, matched to this link.'} "
            "We request that the domain be suspended pending review."
        )
    raise ValueError(f"unknown kind: {kind}")


def _build_prompt(kind: str, ctx: TrackContext) -> str:
    template = (PROMPT_DIR / f"{kind}.txt").read_text(encoding="utf-8")
    values = {
        "track_id": ctx.track_id,
        "lat": f"{ctx.lat:.5f}",
        "lon": f"{ctx.lon:.5f}",
        "heading_deg": f"{ctx.heading_deg:.0f}",
        "heading_name": _compass(ctx.heading_deg),
        "speed_mph": f"{ctx.speed_mps * 2.237:.0f}",
        "intercept": (
            f"{ctx.intercept_lat:.5f}, {ctx.intercept_lon:.5f}"
            if ctx.intercept_lat is not None and ctx.intercept_lon is not None
            else "not available"
        ),
        "eta_s": ctx.eta_s if ctx.eta_s is not None else "unknown",
        "brand": ctx.brand or "unknown",
        "domain": ctx.domain or "unknown",
        "domain_age": _age(ctx.domain_age_days),
        "first_seen": ctx.first_seen_iso or "unknown",
        "area": ctx.area,
        "evidence": ctx.evidence or "SMS delivered during a 2G downgrade, flagged by a classifier, no match in carrier logs.",
    }
    return template.format(**values)


def _nemotron(prompt: str) -> str:
    url = os.environ.get("NEMOTRON_URL")
    if not url:
        raise RuntimeError("NEMOTRON_URL not set")
    body = json.dumps(
        {
            "model": os.environ.get("NEMOTRON_MODEL", "nemotron"),
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0.3,
            "max_tokens": 400,
        }
    ).encode()
    headers = {"Content-Type": "application/json"}
    if os.environ.get("NEMOTRON_API_KEY"):
        headers["Authorization"] = f"Bearer {os.environ['NEMOTRON_API_KEY']}"
    req = urllib.request.Request(url.rstrip("/") + "/chat/completions", data=body, headers=headers)
    with urllib.request.urlopen(req, timeout=20) as resp:
        data = json.load(resp)
    return data["choices"][0]["message"]["content"].strip().strip('"')


def draft_report(
    track_id: int,
    kind: str,
    *,
    context_loader: Optional[ContextLoader] = None,
    llm: Optional[LlmCall] = None,
) -> dict:
    """Return {"text": str}. Never raises for generation problems; falls back to a template."""
    if kind not in KINDS:
        raise ValueError(f"kind must be one of {KINDS}, got {kind!r}")
    if context_loader is None:
        raise RuntimeError(
            "No context_loader given. Role 2's agent should pass one that reads "
            "track/campaign/prediction rows from Spacetime."
        )
    ctx = context_loader(track_id)
    generate = llm or _nemotron

    try:
        text = generate(_build_prompt(kind, ctx)).strip()
    except Exception:
        return {"text": fallback_text(kind, ctx)}

    ok = (
        validate_warning(text) if kind == "warning"
        else validate_police(text) if kind == "police"
        else validate_registrar(text, ctx)
    )
    return {"text": text if ok else fallback_text(kind, ctx)}
