# FieldTrust

**A review policy engine for LLM structured extraction.**
Per-field confidence, calibrated thresholds, and statistically guaranteed auto-accept precision - all in your browser.

[![test](https://github.com/5seoyoung/fieldtrust/actions/workflows/test.yml/badge.svg)](https://github.com/5seoyoung/fieldtrust/actions/workflows/test.yml)

**Live app:** https://5seoyoung.github.io/fieldtrust/ - nothing you paste ever leaves the page.

---

When you extract structured data (receipts, contracts, reports) with an LLM at scale, some outputs are silently wrong - and you don't know which. So teams either review everything (defeating automation), review nothing (feeding errors downstream), or eyeball raw logprob averages that can't answer *"is 0.7 good enough?"*.

FieldTrust answers a different question:

> **"Above this threshold, auto-accept - precision is at least 95%, with statistical confidence. Below it, route to a human."**

```
$.vendor   geo_prob=0.985  -> AUTO-ACCEPT
$.total    geo_prob=0.819  -> AUTO-ACCEPT
$.date     geo_prob=0.339  -> HUMAN REVIEW   # "2024-02-31" - the model was guessing
```

## What it does

1. **Inspect** - paste an OpenAI chat-completion response captured with `logprobs: true`. FieldTrust reconstructs the completion from tokens, maps every token to its JSON field (`$.items[0].name`) with a position-aware parser, and renders the output with per-field confidence coloring and token-level popovers.
2. **Calibrate** - upload a small labeled history (200–500 rows of `score,correct`). Set a target precision and confidence level.
3. **Decide** - FieldTrust finds the most permissive threshold whose **Wilson lower confidence bound** on auto-accept precision meets your target, and shows the risk–coverage curve. Drag the target slider and watch coverage and field routing flip in real time - that's the cost of a guarantee, made visible.

Everything runs client-side in a single static HTML page. No server, no account, no data leaving your machine - usable even for medical or financial documents that can't touch a SaaS.

## How it relates to existing tools

Per-field logprob scoring is well covered by open-source libraries - [structured-logprobs](https://github.com/arena-ai/structured-logprobs), [llm-confidence](https://github.com/VATBox/llm-confidence), promptrepo-score, and hosted options like Cleanlab TLM. FieldTrust is not a replacement for them: it's the **decision layer on top**. Scores alone can't tell you where to draw the line; FieldTrust turns scores plus a small labeled sample into an operating policy with a statistical guarantee (Wilson lower bound today, Learn-then-Test on the roadmap).

## Python package

The `python/` directory contains the reference implementation (same algorithms as the web app), installable with pip:

```bash
pip install -e python/
```

```python
from openai import OpenAI
from fieldtrust import tokens_from_openai, score_fields, GuaranteedThreshold

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

Calibrating a review policy:

```python
import numpy as np
from fieldtrust import GuaranteedThreshold

thr = GuaranteedThreshold(target_precision=0.95, delta=0.05)
result = thr.fit(np.array(calib_scores), np.array(calib_correct))
print(result.threshold, result.auto_accept_rate, result.precision_lower_bound)

mask = thr.auto_accept(new_scores)   # True = auto-accept, False = human review
```

See [python/README.md](python/README.md) for design notes.

## Development

```bash
# web app tests (extracts the core script from index.html; jsdom smoke test)
npm ci && npm test

# python tests
pip install -e python/ pytest
pytest tests/test_python.py

# demo without an API key
python python/examples/demo.py
```

The web app is a single dependency-free `index.html`; the Python package is the algorithmic reference. Core algorithm changes must keep both test suites green (see [docs/DECISIONS.md](docs/DECISIONS.md)).

## Roadmap

- **v0.1** - CORD receipt benchmark: AUROC of per-field scores vs. actual extraction errors
- **v0.2** - live API mode (key stays in memory), batch review queue, policy export (JSON threshold config shared between web app and Python)
- **v1.0** - self-consistency fallback for providers without logprobs, Learn-then-Test multi-threshold risk control

## License

[MIT](LICENSE)
