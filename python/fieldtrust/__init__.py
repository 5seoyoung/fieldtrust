"""FieldTrust: per-field calibrated confidence for LLM structured outputs."""

from .alignment import FieldScore, Token, score_fields, tokens_from_openai
from .calibrate import GuaranteedThreshold, PlattCalibrator, ThresholdResult
from .json_spans import extract_value_spans

__version__ = "0.0.1"

__all__ = [
    "Token", "FieldScore", "score_fields", "tokens_from_openai",
    "PlattCalibrator", "GuaranteedThreshold", "ThresholdResult",
    "extract_value_spans",
]
