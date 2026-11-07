"""draft_report: text generation for warnings, police briefs and registrar reports.

Signature (INTERFACES.md section 7):
    draft_report(track_id, kind) -> {"text": str}
"""
from .draft_report import draft_report, TrackContext, validate_warning, fallback_text

__all__ = ["draft_report", "TrackContext", "validate_warning", "fallback_text"]
