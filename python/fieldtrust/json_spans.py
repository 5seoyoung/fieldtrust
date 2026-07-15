"""Position-aware JSON scanner.

Extracts the character span (start, end) of every *value* in a JSON
document, keyed by a JSONPath-like string, e.g.:

    $.vendor          -> (12, 23)
    $.items[0].name   -> (58, 71)

Spans cover the raw JSON text of the value (including quotes for
strings), which is exactly what we need to intersect with token
character offsets.

Pure stdlib, no dependencies.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Tuple

WHITESPACE = " \t\n\r"


class JSONSpanError(ValueError):
    pass


@dataclass(frozen=True)
class ValueSpan:
    path: str
    start: int  # inclusive char offset
    end: int    # exclusive char offset
    kind: str   # "string" | "number" | "bool" | "null" | "object" | "array"


def extract_value_spans(text: str) -> Dict[str, ValueSpan]:
    """Parse ``text`` as JSON and return {path: ValueSpan} for every value.

    Container values (objects/arrays) are included too, so callers can
    score either leaves or whole sub-objects.
    """
    scanner = _Scanner(text)
    spans: Dict[str, ValueSpan] = {}
    scanner.skip_ws()
    scanner.parse_value("$", spans)
    scanner.skip_ws()
    if scanner.pos != len(text):
        raise JSONSpanError(f"Trailing data at position {scanner.pos}")
    return spans


class _Scanner:
    def __init__(self, text: str):
        self.text = text
        self.pos = 0

    # -- helpers -----------------------------------------------------
    def peek(self) -> str:
        if self.pos >= len(self.text):
            raise JSONSpanError("Unexpected end of input")
        return self.text[self.pos]

    def skip_ws(self) -> None:
        while self.pos < len(self.text) and self.text[self.pos] in WHITESPACE:
            self.pos += 1

    def expect(self, ch: str) -> None:
        if self.peek() != ch:
            raise JSONSpanError(
                f"Expected {ch!r} at position {self.pos}, got {self.peek()!r}"
            )
        self.pos += 1

    # -- value dispatch ----------------------------------------------
    def parse_value(self, path: str, spans: Dict[str, ValueSpan]) -> None:
        self.skip_ws()
        ch = self.peek()
        start = self.pos
        if ch == "{":
            self.parse_object(path, spans)
            spans[path] = ValueSpan(path, start, self.pos, "object")
        elif ch == "[":
            self.parse_array(path, spans)
            spans[path] = ValueSpan(path, start, self.pos, "array")
        elif ch == '"':
            self.parse_string()
            spans[path] = ValueSpan(path, start, self.pos, "string")
        elif ch in "-0123456789":
            self.parse_number()
            spans[path] = ValueSpan(path, start, self.pos, "number")
        elif self.text.startswith("true", self.pos):
            self.pos += 4
            spans[path] = ValueSpan(path, start, self.pos, "bool")
        elif self.text.startswith("false", self.pos):
            self.pos += 5
            spans[path] = ValueSpan(path, start, self.pos, "bool")
        elif self.text.startswith("null", self.pos):
            self.pos += 4
            spans[path] = ValueSpan(path, start, self.pos, "null")
        else:
            raise JSONSpanError(f"Unexpected character {ch!r} at {self.pos}")

    # -- composites ----------------------------------------------------
    def parse_object(self, path: str, spans: Dict[str, ValueSpan]) -> None:
        self.expect("{")
        self.skip_ws()
        if self.peek() == "}":
            self.pos += 1
            return
        while True:
            self.skip_ws()
            key = self.parse_string()
            self.skip_ws()
            self.expect(":")
            self.parse_value(f"{path}.{key}", spans)
            self.skip_ws()
            if self.peek() == ",":
                self.pos += 1
                continue
            self.expect("}")
            return

    def parse_array(self, path: str, spans: Dict[str, ValueSpan]) -> None:
        self.expect("[")
        self.skip_ws()
        if self.peek() == "]":
            self.pos += 1
            return
        idx = 0
        while True:
            self.parse_value(f"{path}[{idx}]", spans)
            idx += 1
            self.skip_ws()
            if self.peek() == ",":
                self.pos += 1
                continue
            self.expect("]")
            return

    # -- scalars -------------------------------------------------------
    def parse_string(self) -> str:
        self.expect('"')
        out = []
        while True:
            ch = self.peek()
            self.pos += 1
            if ch == '"':
                return "".join(out)
            if ch == "\\":
                esc = self.peek()
                self.pos += 1
                if esc == "u":
                    hex4 = self.text[self.pos : self.pos + 4]
                    if len(hex4) < 4:
                        raise JSONSpanError("Bad \\u escape")
                    out.append(chr(int(hex4, 16)))
                    self.pos += 4
                else:
                    out.append(
                        {"n": "\n", "t": "\t", "r": "\r", "b": "\b",
                         "f": "\f", '"': '"', "\\": "\\", "/": "/"}.get(esc, esc)
                    )
            else:
                out.append(ch)

    def parse_number(self) -> None:
        if self.peek() == "-":
            self.pos += 1
        while self.pos < len(self.text) and self.text[self.pos] in "0123456789.eE+-":
            self.pos += 1
