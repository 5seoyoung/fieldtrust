# FieldTrust

**Per-field calibrated confidence for LLM structured outputs.**

Extracting structured data (invoices, contracts, reports) with LLMs works -
until it silently doesn't. FieldTrust tells you *which fields to trust* and
*which to route to human review*, with a statistical guarantee on the
precision of everything you auto-accept.

```
$.vendor   geo_prob=0.985  -> AUTO-ACCEPT
$.total    geo_prob=0.819  -> AUTO-ACCEPT
$.date     geo_prob=0.339  -> HUMAN REVIEW   # 2024-02-31, the model was guessing
```

## How it works

1. **Token→field alignment** - reconstructs the completion text from token
   logprobs, then uses a position-aware JSON parser to map every token to a
   JSONPath (`$.items[0].name`). Tokenizer-agnostic: works with OpenAI,
   vLLM, or anything that returns token strings + logprobs.
2. **Per-field scores** - geometric-mean probability, min token probability,
   top-2 margin (when `top_logprobs` is requested).
3. **Guaranteed thresholding** - on a small calibration set (~200-500
   labeled fields), finds the most permissive threshold whose *lower
   confidence bound* on auto-accept precision meets your target
   (e.g. ≥95% with 95% confidence).

## Quickstart (OpenAI)

```python
from openai import OpenAI
from fieldtrust import tokens_from_openai, score_fields

client = OpenAI()
resp = client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[{"role": "user", "content": f"Extract vendor, total, date as JSON:\n{receipt_text}"}],
    response_format={"type": "json_object"},
    logprobs=True,
    top_logprobs=2,   # enables margin scores
)

tokens = tokens_from_openai(resp.choices[0].logprobs.content)
for path, fs in score_fields(tokens).items():
    print(path, fs.geo_prob, fs.min_prob, fs.mean_margin)
```

### Calibrating a review policy

```python
import numpy as np
from fieldtrust import GuaranteedThreshold

# calib_scores: mean_logprob per field, calib_correct: bool (was it right?)
thr = GuaranteedThreshold(target_precision=0.95, delta=0.05)
result = thr.fit(np.array(calib_scores), np.array(calib_correct))

print(result.threshold, result.auto_accept_rate, result.precision_lower_bound)
mask = thr.auto_accept(new_scores)   # True = auto-accept, False = human review
```

## Design notes

- **Why strip quotes from string spans?** Under structured-output decoding,
  punctuation/key tokens are near-deterministic and dilute the signal.
  We score only value content by default.
- **Why Wilson bound?** Dependency-free and tight enough for MVP.
  Roadmap: exact Clopper-Pearson, then Learn-then-Test for multi-threshold
  risk control.
- **No logprobs available (e.g. Anthropic)?** Roadmap: self-consistency
  fallback - sample k extractions, per-field agreement rate as the score.
  Same calibration machinery applies.

## Roadmap

- [ ] CORD / SROIE benchmark: AUROC of per-field scores vs. actual errors
- [ ] Platt/temperature calibration on top of raw scores (included, unwired)
- [ ] Self-consistency fallback adapter (provider-agnostic)
- [ ] Static HTML review-queue report
- [ ] vLLM adapter

## Development

```bash
pip install -e .
PYTHONPATH=. python examples/demo.py   # no API key needed
```
