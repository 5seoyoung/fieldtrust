"""Calibration & selective-prediction thresholding.

Two components, both dependency-light (numpy only):

1. ``PlattCalibrator`` - maps a raw confidence score (e.g. mean logprob)
   to a calibrated P(field is correct) via 1-D logistic regression.

2. ``GuaranteedThreshold`` - given calibration data (score, correct),
   finds the lowest threshold t such that the *statistical lower bound*
   (Wilson) on precision among auto-accepted fields (score >= t) meets a
   target, with confidence 1 - delta. Fields below t are routed to
   human review.

   This is the pragmatic MVP guarantee; swap in Clopper–Pearson or
   Learn-then-Test (Angelopoulos et al.) later for exact/finite-sample
   risk control.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import numpy as np


# ---------------------------------------------------------------------------
# 1. Platt scaling (1-D logistic regression, Newton's method)
# ---------------------------------------------------------------------------

class PlattCalibrator:
    def __init__(self):
        self.a: float = 1.0
        self.b: float = 0.0

    def fit(self, scores: np.ndarray, correct: np.ndarray,
            n_iter: int = 100, tol: float = 1e-8) -> "PlattCalibrator":
        x = np.asarray(scores, dtype=float)
        y = np.asarray(correct, dtype=float)
        a, b = 1.0, 0.0
        for _ in range(n_iter):
            z = a * x + b
            p = 1.0 / (1.0 + np.exp(-z))
            g = np.array([np.sum((p - y) * x), np.sum(p - y)])
            w = p * (1 - p) + 1e-12
            H = np.array([
                [np.sum(w * x * x), np.sum(w * x)],
                [np.sum(w * x),     np.sum(w)],
            ])
            try:
                step = np.linalg.solve(H, g)
            except np.linalg.LinAlgError:
                break
            a, b = a - step[0], b - step[1]
            if np.max(np.abs(step)) < tol:
                break
        self.a, self.b = float(a), float(b)
        return self

    def predict_proba(self, scores: np.ndarray) -> np.ndarray:
        x = np.asarray(scores, dtype=float)
        return 1.0 / (1.0 + np.exp(-(self.a * x + self.b)))


# ---------------------------------------------------------------------------
# 2. Guaranteed-precision threshold
# ---------------------------------------------------------------------------

def wilson_lower_bound(k: int, n: int, delta: float) -> float:
    """Lower (1 - delta) confidence bound on a binomial proportion."""
    if n == 0:
        return 0.0
    # z for one-sided (1 - delta); inverse normal CDF via
    # Acklam-style rational approximation (good to ~1e-9).
    z = _norm_ppf(1.0 - delta)
    phat = k / n
    denom = 1.0 + z * z / n
    center = phat + z * z / (2 * n)
    rad = z * np.sqrt(phat * (1 - phat) / n + z * z / (4 * n * n))
    return max(0.0, (center - rad) / denom)


def _norm_ppf(p: float) -> float:
    # Peter Acklam's inverse normal CDF approximation.
    a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
         1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00]
    b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
         6.680131188771972e+01, -1.328068155288572e+01]
    c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
         -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00]
    d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
         3.754408661907416e+00]
    plow, phigh = 0.02425, 1 - 0.02425
    if p < plow:
        q = np.sqrt(-2 * np.log(p))
        return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / \
               ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1)
    if p > phigh:
        q = np.sqrt(-2 * np.log(1 - p))
        return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / \
               ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1)
    q = p - 0.5
    r = q * q
    return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q / \
           (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1)


@dataclass
class ThresholdResult:
    threshold: float
    target_precision: float
    delta: float
    n_calib: int
    auto_accept_rate: float          # coverage on the calibration set
    empirical_precision: float       # precision among accepted (calib)
    precision_lower_bound: float     # Wilson LCB at chosen threshold
    feasible: bool                   # False if no threshold satisfies target


class GuaranteedThreshold:
    """Pick the most permissive threshold whose precision LCB >= target."""

    def __init__(self, target_precision: float = 0.95, delta: float = 0.05):
        self.target_precision = target_precision
        self.delta = delta
        self.result: Optional[ThresholdResult] = None

    def fit(self, scores: np.ndarray, correct: np.ndarray) -> ThresholdResult:
        s = np.asarray(scores, dtype=float)
        y = np.asarray(correct, dtype=bool)
        order = np.argsort(-s)              # descending by confidence
        s_sorted, y_sorted = s[order], y[order]
        n = len(s_sorted)

        cum_correct = np.cumsum(y_sorted)
        best = None
        # candidate thresholds = each observed score (accept top-i items)
        for i in range(1, n + 1):
            k = int(cum_correct[i - 1])
            lcb = wilson_lower_bound(k, i, self.delta)
            if lcb >= self.target_precision:
                best = (i, k, lcb)          # keep the largest feasible i
        if best is None:
            self.result = ThresholdResult(
                threshold=float("inf"), target_precision=self.target_precision,
                delta=self.delta, n_calib=n, auto_accept_rate=0.0,
                empirical_precision=float("nan"),
                precision_lower_bound=0.0, feasible=False,
            )
            return self.result

        i, k, lcb = best
        self.result = ThresholdResult(
            threshold=float(s_sorted[i - 1]),
            target_precision=self.target_precision,
            delta=self.delta,
            n_calib=n,
            auto_accept_rate=i / n,
            empirical_precision=k / i,
            precision_lower_bound=lcb,
            feasible=True,
        )
        return self.result

    def auto_accept(self, scores: np.ndarray) -> np.ndarray:
        if self.result is None:
            raise RuntimeError("Call fit() first")
        return np.asarray(scores, dtype=float) >= self.result.threshold
