"""Tests for the Python reference package (json_spans / alignment / calibrate).

Covers the edge cases listed in docs/PLAN.md §13.3:
- json_spans: nesting / arrays / escapes / unicode / empty strings
- alignment: field scoring incl. markdown-fenced completions
- calibrate: Wilson bound reference value wilson(99, 100, 0.05) ~= 0.9564
"""

import math

import numpy as np
import pytest

from fieldtrust import (
    GuaranteedThreshold,
    PlattCalibrator,
    Token,
    extract_value_spans,
    score_fields,
    tokens_from_openai,
)
from fieldtrust.calibrate import wilson_lower_bound
from fieldtrust.json_spans import JSONSpanError


# ---------------------------------------------------------------------------
# json_spans
# ---------------------------------------------------------------------------

class TestExtractValueSpans:
    def test_flat_object(self):
        text = '{"a": 1, "b": "x"}'
        spans = extract_value_spans(text)
        assert text[spans["$.a"].start:spans["$.a"].end] == "1"
        assert text[spans["$.b"].start:spans["$.b"].end] == '"x"'
        assert spans["$.a"].kind == "number"
        assert spans["$.b"].kind == "string"
        assert spans["$"].kind == "object"

    def test_nested_object(self):
        text = '{"a": {"b": {"c": 42}}}'
        spans = extract_value_spans(text)
        assert text[spans["$.a.b.c"].start:spans["$.a.b.c"].end] == "42"
        assert spans["$.a.b"].kind == "object"

    def test_arrays_and_nested_arrays(self):
        text = '{"items": [{"name": "Latte", "qty": 2}, {"name": "Muffin"}], "m": [[1, 2], [3]]}'
        spans = extract_value_spans(text)
        assert text[spans["$.items[0].name"].start:spans["$.items[0].name"].end] == '"Latte"'
        assert text[spans["$.items[1].name"].start:spans["$.items[1].name"].end] == '"Muffin"'
        assert text[spans["$.m[0][1]"].start:spans["$.m[0][1]"].end] == "2"
        assert text[spans["$.m[1][0]"].start:spans["$.m[1][0]"].end] == "3"
        assert spans["$.items"].kind == "array"

    def test_escapes(self):
        text = r'{"a": "line\nbreak", "b": "quote\"inside", "c": "back\\slash"}'
        spans = extract_value_spans(text)
        # spans cover the raw text, including escape sequences
        assert text[spans["$.a"].start:spans["$.a"].end] == r'"line\nbreak"'
        assert text[spans["$.b"].start:spans["$.b"].end] == r'"quote\"inside"'
        assert text[spans["$.c"].start:spans["$.c"].end] == r'"back\\slash"'

    def test_unicode_escape_and_raw(self):
        text = '{"u": "caf\\u00e9", "raw": "카페"}'
        spans = extract_value_spans(text)
        assert text[spans["$.u"].start:spans["$.u"].end] == '"caf\\u00e9"'
        assert text[spans["$.raw"].start:spans["$.raw"].end] == '"카페"'

    def test_empty_string_and_empty_containers(self):
        text = '{"s": "", "o": {}, "a": []}'
        spans = extract_value_spans(text)
        assert text[spans["$.s"].start:spans["$.s"].end] == '""'
        assert text[spans["$.o"].start:spans["$.o"].end] == "{}"
        assert text[spans["$.a"].start:spans["$.a"].end] == "[]"

    def test_literals_and_negative_numbers(self):
        text = '{"t": true, "f": false, "n": null, "neg": -3.5e-2}'
        spans = extract_value_spans(text)
        assert spans["$.t"].kind == "bool"
        assert spans["$.f"].kind == "bool"
        assert spans["$.n"].kind == "null"
        assert text[spans["$.neg"].start:spans["$.neg"].end] == "-3.5e-2"

    def test_top_level_array(self):
        spans = extract_value_spans('[1, "two"]')
        assert spans["$[0]"].kind == "number"
        assert spans["$[1]"].kind == "string"

    def test_trailing_data_raises(self):
        with pytest.raises(JSONSpanError):
            extract_value_spans('{"a": 1} garbage')

    def test_truncated_raises(self):
        with pytest.raises(JSONSpanError):
            extract_value_spans('{"a": ')


# ---------------------------------------------------------------------------
# alignment
# ---------------------------------------------------------------------------

def _tokens_simple():
    # {"vendor": "Starbucks", "total": 12.5}
    return [
        Token('{"', -0.001), Token('vendor', -0.001), Token('":', -0.001),
        Token(' "', -0.002),
        Token('Star', -0.01, second_logprob=-5.2),
        Token('bucks', -0.02, second_logprob=-4.8),
        Token('",', -0.001),
        Token(' "', -0.001), Token('total', -0.001), Token('":', -0.001),
        Token(' ', -0.002),
        Token('12', -0.15, second_logprob=-2.9),
        Token('.5', -0.25, second_logprob=-2.1),
        Token('}', -0.001),
    ]


class TestScoreFields:
    def test_basic_scores(self):
        scores = score_fields(_tokens_simple())
        assert set(scores) == {"$.vendor", "$.total"}
        v = scores["$.vendor"]
        # strip_quotes: only the two value tokens are scored
        assert v.n_tokens == 2
        assert v.mean_logprob == pytest.approx((-0.01 - 0.02) / 2)
        assert v.min_logprob == pytest.approx(-0.02)
        assert v.geo_prob == pytest.approx(math.exp(-0.015))
        assert v.mean_margin == pytest.approx(((-0.01 + 5.2) + (-0.02 + 4.8)) / 2)
        t = scores["$.total"]
        assert t.n_tokens == 2
        assert t.mean_logprob == pytest.approx((-0.15 - 0.25) / 2)

    def test_markdown_fence(self):
        # Same JSON wrapped in a ```json fence, as models often emit.
        tokens = (
            [Token("```", -0.001), Token("json", -0.001), Token("\n", -0.001)]
            + _tokens_simple()
            + [Token("\n", -0.001), Token("```", -0.001)]
        )
        fenced = score_fields(tokens)
        plain = score_fields(_tokens_simple())
        assert set(fenced) == set(plain)
        for path in plain:
            assert fenced[path].mean_logprob == pytest.approx(plain[path].mean_logprob)
            assert fenced[path].n_tokens == plain[path].n_tokens

    def test_no_json_raises(self):
        with pytest.raises(JSONSpanError):
            score_fields([Token("no json here", -0.1)])

    def test_nested_paths(self):
        tokens = [
            Token('{"items": [{"n": ', -0.001),
            Token('"A"', -0.5),
            Token('}, {"n": ', -0.001),
            Token('"B"', -0.7),
            Token("}]}", -0.001),
        ]
        scores = score_fields(tokens)
        assert scores["$.items[0].n"].min_logprob == pytest.approx(-0.5)
        assert scores["$.items[1].n"].min_logprob == pytest.approx(-0.7)

    def test_leaves_only_default(self):
        scores = score_fields(_tokens_simple())
        assert "$" not in scores  # container spans skipped

    def test_empty_string_value_keeps_quote_tokens(self):
        tokens = [Token('{"a": ', -0.001), Token('""', -0.3), Token("}", -0.001)]
        scores = score_fields(tokens)
        assert scores["$.a"].n_tokens == 1
        assert scores["$.a"].min_logprob == pytest.approx(-0.3)

    def test_strip_quotes_off(self):
        scores = score_fields(_tokens_simple(), strip_quotes=False)
        # quote/punctuation tokens now overlap the span
        assert scores["$.vendor"].n_tokens > 2


class TestTokensFromOpenAI:
    def test_dict_input_with_margins(self):
        content = [
            {"token": "Star", "logprob": -0.01,
             "top_logprobs": [{"token": "Star", "logprob": -0.01},
                              {"token": "Moon", "logprob": -4.5}]},
            {"token": "bucks", "logprob": -0.02, "top_logprobs": []},
        ]
        toks = tokens_from_openai(content)
        assert toks[0].second_logprob == pytest.approx(-4.5)
        assert toks[1].second_logprob is None
        assert toks[1].text == "bucks"


# ---------------------------------------------------------------------------
# calibrate
# ---------------------------------------------------------------------------

class TestWilson:
    def test_reference_value(self):
        # Reference from docs/PLAN.md §13.3
        assert wilson_lower_bound(99, 100, 0.05) == pytest.approx(0.9564, abs=5e-4)

    def test_zero_n(self):
        assert wilson_lower_bound(0, 0, 0.05) == 0.0

    def test_bounds_and_monotonicity(self):
        lcb_small = wilson_lower_bound(9, 10, 0.05)
        lcb_large = wilson_lower_bound(90, 100, 0.05)
        assert 0.0 <= lcb_small < 0.9
        assert lcb_small < lcb_large < 0.9  # more data -> tighter bound, still < phat

    def test_perfect_below_one(self):
        assert wilson_lower_bound(100, 100, 0.05) < 1.0


class TestGuaranteedThreshold:
    def _calib(self):
        rng = np.random.default_rng(0)
        n = 500
        scores = rng.uniform(-3.0, 0.0, size=n)
        p = 1 / (1 + np.exp(-(3.0 * scores + 4.0)))
        correct = rng.uniform(size=n) < p
        return scores, correct

    def test_fit_guarantee_holds_on_calib(self):
        scores, correct = self._calib()
        thr = GuaranteedThreshold(target_precision=0.95, delta=0.05)
        res = thr.fit(scores, correct)
        assert res.feasible
        assert res.precision_lower_bound >= 0.95
        assert 0 < res.auto_accept_rate < 1
        # accepted set matches the reported rate / precision
        mask = thr.auto_accept(scores)
        assert mask.mean() == pytest.approx(res.auto_accept_rate)
        assert correct[mask].mean() == pytest.approx(res.empirical_precision)

    def test_infeasible_target(self):
        scores = np.array([-1.0, -2.0, -3.0])
        correct = np.array([False, False, False])
        res = GuaranteedThreshold(0.95, 0.05).fit(scores, correct)
        assert not res.feasible
        assert res.auto_accept_rate == 0.0
        assert res.threshold == float("inf")

    def test_stricter_delta_accepts_less(self):
        scores, correct = self._calib()
        loose = GuaranteedThreshold(0.95, delta=0.10).fit(scores, correct)
        strict = GuaranteedThreshold(0.95, delta=0.01).fit(scores, correct)
        assert strict.auto_accept_rate <= loose.auto_accept_rate


class TestPlattCalibrator:
    def test_recovers_monotone_mapping(self):
        rng = np.random.default_rng(1)
        x = rng.uniform(-3, 0, size=2000)
        p = 1 / (1 + np.exp(-(2.0 * x + 3.0)))
        y = (rng.uniform(size=2000) < p).astype(float)
        cal = PlattCalibrator().fit(x, y)
        assert cal.a == pytest.approx(2.0, abs=0.5)
        assert cal.b == pytest.approx(3.0, abs=0.7)
        probs = cal.predict_proba(np.array([-3.0, -1.5, 0.0]))
        assert np.all(np.diff(probs) > 0)  # monotone increasing
        assert np.all((probs >= 0) & (probs <= 1))
