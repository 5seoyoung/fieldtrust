"""End-to-end smoke test with synthetic data (no API key needed).

1. Simulates a receipt extraction where the model is confident about
   `vendor`/`total` but shaky about `date` (an OCR-ambiguous field).
2. Aligns tokens to fields and prints per-field scores.
3. Fits a guaranteed-precision threshold on a synthetic calibration set
   and reports coverage.
"""

import numpy as np

from fieldtrust import GuaranteedThreshold, Token, score_fields

# ---------------------------------------------------------------------------
# 1. Fake LLM output: {"vendor": "Starbucks", "total": 12.5, "date": "2024-02-31"}
#    Tokenized roughly the way a BPE tokenizer would split it.
# ---------------------------------------------------------------------------
tokens = [
    Token('{"', -0.001), Token('vendor', -0.001), Token('":', -0.001),
    Token(' "', -0.002),
    Token('Star', -0.01, second_logprob=-5.2),
    Token('bucks', -0.02, second_logprob=-4.8),
    Token('",', -0.001),
    Token(' "', -0.001), Token('total', -0.001), Token('":', -0.001),
    Token(' ', -0.002),
    Token('12', -0.15, second_logprob=-2.9),
    Token('.5', -0.25, second_logprob=-2.1),
    Token(',', -0.001),
    Token(' "', -0.001), Token('date', -0.001), Token('":', -0.001),
    Token(' "', -0.002),
    Token('202', -0.05, second_logprob=-3.5),
    Token('4', -0.08, second_logprob=-3.0),
    Token('-02-', -1.9, second_logprob=-2.0),   # model unsure: 02 vs 03?
    Token('31', -2.3, second_logprob=-2.4),     # 31 Feb - nearly a coin flip
    Token('"}', -0.001),
]

scores = score_fields(tokens)
print("=== Per-field scores ===")
for path, fs in scores.items():
    margin = f"{fs.mean_margin:6.2f}" if fs.mean_margin is not None else "  n/a"
    print(f"{path:12s} kind={fs.kind:7s} tokens={fs.n_tokens}  "
          f"geo_prob={fs.geo_prob:.3f}  min_prob={fs.min_prob:.3f}  "
          f"mean_margin={margin}")

# ---------------------------------------------------------------------------
# 2. Guaranteed-precision threshold on a synthetic calibration set.
#    Simulate 500 fields: higher score -> more likely correct.
# ---------------------------------------------------------------------------
rng = np.random.default_rng(0)
n = 500
calib_scores = rng.uniform(-3.0, 0.0, size=n)            # mean logprob per field
p_correct = 1 / (1 + np.exp(-(3.0 * calib_scores + 4.0)))  # ground-truth relation
calib_correct = rng.uniform(size=n) < p_correct

thr = GuaranteedThreshold(target_precision=0.95, delta=0.05)
res = thr.fit(calib_scores, calib_correct)

print("\n=== Guaranteed threshold (target precision 0.95, delta 0.05) ===")
print(f"feasible            : {res.feasible}")
print(f"threshold (mean lp) : {res.threshold:.4f}")
print(f"auto-accept rate    : {res.auto_accept_rate:.1%}")
print(f"empirical precision : {res.empirical_precision:.3f}")
print(f"precision LCB       : {res.precision_lower_bound:.3f}")

# Apply to our demo fields
print("\n=== Routing decision for demo fields ===")
for path, fs in scores.items():
    decision = "AUTO-ACCEPT" if fs.mean_logprob >= res.threshold else "HUMAN REVIEW"
    print(f"{path:12s} mean_logprob={fs.mean_logprob:7.3f}  ->  {decision}")
