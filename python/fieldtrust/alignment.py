"""Align token-level logprobs with JSON field spans.

Input format is provider-agnostic: a list of ``Token`` records with the
token's surface string and its logprob (plus optional top-k margin
info). For OpenAI chat completions this maps directly from
``choice.logprobs.content``; for vLLM from ``output.logprobs``.

The completion text is reconstructed by concatenating token strings, so
alignment does not depend on any tokenizer internals.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence

from .json_spans import JSONSpanError, ValueSpan, extract_value_spans


@dataclass
class Token:
    text: str
    logprob: float
    # logprob of the runner-up token at this position, if available
    # (from top_logprobs). Enables margin-based scores.
    second_logprob: Optional[float] = None


@dataclass
class FieldScore:
    path: str
    kind: str
    n_tokens: int
    mean_logprob: float
    min_logprob: float
    sum_logprob: float
    mean_margin: Optional[float]  # avg (top1 - top2) logprob gap, if available

    @property
    def geo_prob(self) -> float:
        """Geometric-mean token probability (length-normalized)."""
        return math.exp(self.mean_logprob)

    @property
    def joint_prob(self) -> float:
        """Joint probability of the whole field (product of token probs)."""
        return math.exp(self.sum_logprob)

    @property
    def min_prob(self) -> float:
        return math.exp(self.min_logprob)


def token_offsets(tokens: Sequence[Token]) -> List[tuple]:
    """Char (start, end) for each token in the concatenated text."""
    offsets = []
    pos = 0
    for t in tokens:
        offsets.append((pos, pos + len(t.text)))
        pos += len(t.text)
    return offsets


def score_fields(
    tokens: Sequence[Token],
    leaves_only: bool = True,
    strip_quotes: bool = True,
) -> Dict[str, FieldScore]:
    """Map token logprobs onto JSON fields.

    Parameters
    ----------
    tokens: token records whose concatenation is a JSON document.
    leaves_only: if True, skip object/array container spans.
    strip_quotes: if True, exclude the opening/closing quote chars of
        string values from the span before intersecting with tokens.
        This avoids diluting the signal with punctuation tokens that
        are (almost) deterministic under structured-output decoding.
    """
    text = "".join(t.text for t in tokens)
    # Tolerate markdown fences / prose around the JSON object (same
    # behaviour as the JS port). Plain-JSON inputs take the direct path,
    # so top-level arrays/scalars keep working.
    j_offset = 0
    try:
        spans = extract_value_spans(text)
    except JSONSpanError:
        j_start = text.find("{")
        j_end = text.rfind("}") + 1
        if j_start < 0 or j_end <= j_start:
            raise JSONSpanError("No JSON object found in tokens") from None
        spans = extract_value_spans(text[j_start:j_end])
        j_offset = j_start
    offsets = token_offsets(tokens)

    scores: Dict[str, FieldScore] = {}
    for path, span in spans.items():
        if leaves_only and span.kind in ("object", "array"):
            continue
        start, end = span.start + j_offset, span.end + j_offset
        if strip_quotes and span.kind == "string" and end - start >= 2:
            start, end = start + 1, end - 1
            if start == end:  # empty string value: keep the quotes
                start, end = span.start + j_offset, span.end + j_offset

        lps: List[float] = []
        margins: List[float] = []
        for (ts, te), tok in zip(offsets, tokens):
            if ts < end and te > start:  # overlap
                lps.append(tok.logprob)
                if tok.second_logprob is not None:
                    margins.append(tok.logprob - tok.second_logprob)
        if not lps:
            continue
        scores[path] = FieldScore(
            path=path,
            kind=span.kind,
            n_tokens=len(lps),
            mean_logprob=sum(lps) / len(lps),
            min_logprob=min(lps),
            sum_logprob=sum(lps),
            mean_margin=(sum(margins) / len(margins)) if margins else None,
        )
    return scores


# ---------------------------------------------------------------------------
# Provider adapters
# ---------------------------------------------------------------------------

def tokens_from_openai(choice_logprobs_content: list) -> List[Token]:
    """Convert OpenAI ``choice.logprobs.content`` into Token records.

    Works with both dicts (raw JSON) and SDK objects (attribute access).
    Request must be made with ``logprobs=True`` and ideally
    ``top_logprobs=2`` (or more) so margins are available.
    """
    out: List[Token] = []
    for item in choice_logprobs_content:
        get = (lambda o, k: o.get(k)) if isinstance(item, dict) else getattr
        text = get(item, "token")
        lp = get(item, "logprob")
        top = get(item, "top_logprobs") or []
        second = None
        # top_logprobs includes the chosen token; find the best *other* one.
        others = []
        for cand in top:
            cget = (lambda o, k: o.get(k)) if isinstance(cand, dict) else getattr
            if cget(cand, "token") != text:
                others.append(cget(cand, "logprob"))
        if others:
            second = max(others)
        out.append(Token(text=text, logprob=lp, second_logprob=second))
    return out
