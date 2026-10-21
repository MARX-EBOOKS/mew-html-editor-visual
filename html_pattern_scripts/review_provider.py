"""Provider contract. Providers receive memory data and never perform file IO.

Register instances in html_pattern_review.PROVIDERS. A provider exposes id, label,
requires_pdf, reviewable, patterns, kinds, actions and compare(context) -> dict(matches=[...], ...).
Offsets are Python character offsets into context.source. PDF candidates include
id, pattern, start/end, line/column, text, ocr, context, spans, crops, kind,
decision, optional choices and optional edits [(start, end, replacement), ...].
Edits must be ordered, non-overlapping source ranges; the backend alone applies
them after version validation. Omit choices to allow all provider actions.
actions contains {id, label, input?: 'text' | 'source'}. 'source' opens the full
HTML in Monaco at the candidate and passes edited source as text to decide().
decide(context, hit, choice, text)
returns {edits, text, message, advance}. The provider owns all decision semantics.
The backend exposes separate 'previous' and 'next' navigation controls, outside
business actions. Navigation never writes decisions. These two IDs are reserved.
Providers use context.diff for shared normalized text, matcher, maps and crops;
the engine reuses the PDF index and alignment across providers.
"""
from dataclasses import dataclass, field
from functools import cached_property
from typing import Protocol


class ReviewGroup:
    """Metadata for a selection of registered providers; IDs stay unambiguous."""

    def __init__(self, providers):
        self.providers = providers
        self.requires_pdf = any(p.requires_pdf for p in providers)
        self.reviewable = any(p.reviewable for p in providers)
        self.configurable = any(getattr(p, 'configurable', False) for p in providers)
        self.patterns = [{**pattern, 'id': f'{p.id}:{pattern["id"]}',
                          'label': f'{p.label} · {pattern["label"]}'}
                         for p in providers for pattern in p.patterns]
        self.kinds = {f'{p.id}:{key}': f'{p.label} · {label}'
                      for p in providers for key, label in p.kinds.items()}


@dataclass
class ReviewContext:
    source: str
    ocr: str = ''
    coordinates: list = field(default_factory=list)  # (physical page, label, bbox) or None
    styles: list = field(default_factory=list)       # PyMuPDF italic=2, bold=16 per OCR character
    pdf_identity: str = ''

    @cached_property
    def diff(self):
        from diff_engine import Alignment
        return Alignment(self)


class ReviewProvider(Protocol):
    id: str
    label: str
    requires_pdf: bool
    reviewable: bool
    patterns: list
    kinds: dict
    actions: list

    def compare(self, context: ReviewContext) -> dict: ...

    def decide(self, context: ReviewContext, hit: dict, choice: str, text: str | None) -> dict: ...
