"""Shared PDF text index and HTML/OCR alignment, independent of review rules."""
from collections import OrderedDict
from difflib import SequenceMatcher
from functools import cached_property
import hashlib

from review_common import StyledText, normalized
from pdf_text_backend import PdfTextIndex
from review_provider import ReviewContext


class Alignment:
    def __init__(self, context):
        self.visible = StyledText(context.source)
        self.text = ''.join(self.visible.text)
        self.left, self.left_map = normalized(self.text, range(len(self.text)))
        self.right, self.right_map = normalized(context.ocr, range(len(context.ocr)))
        self.matcher = SequenceMatcher(None, self.left, self.right, autojunk=False)
        self.coordinates = context.coordinates

    @cached_property
    def aligned(self):
        return {b + j: a + j for a, b, size in self.matcher.get_matching_blocks() for j in range(size)}

    def crops(self, indices, padding=0):
        indices = list(indices)
        selected = set(indices)
        if indices and padding:
            rows = {(self.coordinates[i][0], round(self.coordinates[i][2][1]))
                    for i in indices if self.coordinates[i]}
            indices = [i for i in range(max(0, indices[0] - padding), min(len(self.coordinates), indices[-1] + padding + 1))
                       if self.coordinates[i] and (self.coordinates[i][0], round(self.coordinates[i][2][1])) in rows]
        boxes, highlights = {}, {}
        for i in indices:
            coord = self.coordinates[i]
            if not coord:
                continue
            page, label, box = coord
            key = (page, label, round(box[1]))
            for regions in ((boxes, highlights) if i in selected else (boxes,)):
                if key not in regions:
                    regions[key] = list(box)
                else:
                    r = regions[key]
                    r[:] = [min(r[0], box[0]), min(r[1], box[1]), max(r[2], box[2]), max(r[3], box[3])]
        return [{'page': k[0], 'label': k[1], 'bbox': box,
                 'highlight': highlights[k]} for k, box in boxes.items()]


class DiffEngine:
    def __init__(self, cache_dir=None):
        self.cache_dir = cache_dir
        self.pdfs, self.contexts = OrderedDict(), OrderedDict()

    def read(self, source, location):
        pdf, start_label, next_label = location
        stat = pdf.stat()
        stamp = (stat.st_mtime_ns, stat.st_size)
        key = (str(pdf), *stamp)
        if key not in self.pdfs:
            # A replaced PDF invalidates its text, geometry and all derived alignments.
            for old in list(self.pdfs):
                if old[0] == str(pdf):
                    del self.pdfs[old]
                    self.contexts.clear()
            index = PdfTextIndex(pdf, stamp, self.cache_dir)
            latest = pdf.stat()
            if (latest.st_mtime_ns, latest.st_size) != stamp:
                raise ValueError('PDF changed while indexing; reload')
            self.pdfs[key] = index
            while len(self.pdfs) > 2:
                self.pdfs.popitem(last=False)
        self.pdfs.move_to_end(key)
        context_key = (key, start_label, next_label, hashlib.sha256(source.encode('utf-8')).digest())
        if context_key not in self.contexts:
            data, pages = self.pdfs[key].context(source, start_label, next_label)
            self.contexts[context_key] = ReviewContext(**data), pages
            while len(self.contexts) > 32:
                self.contexts.popitem(last=False)
        self.contexts.move_to_end(context_key)
        return self.contexts[context_key]
