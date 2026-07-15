// FieldTrust core - JS port of json_spans.py / alignment.py / calibrate.py
// Pure functions, no DOM. Testable in Node.

// ---------- position-aware JSON scanner ----------
function extractValueSpans(text) {
  let pos = 0;
  const spans = {};
  const WS = " \t\n\r";

  function peek() {
    if (pos >= text.length) throw new Error("Unexpected end of input");
    return text[pos];
  }
  function skipWs() { while (pos < text.length && WS.includes(text[pos])) pos++; }
  function expect(ch) {
    if (peek() !== ch) throw new Error(`Expected ${ch} at ${pos}, got ${peek()}`);
    pos++;
  }
  function parseString() {
    expect('"');
    let out = "";
    for (;;) {
      const ch = peek(); pos++;
      if (ch === '"') return out;
      if (ch === "\\") {
        const esc = peek(); pos++;
        if (esc === "u") {
          out += String.fromCharCode(parseInt(text.slice(pos, pos + 4), 16));
          pos += 4;
        } else {
          out += ({ n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" }[esc] ?? esc);
        }
      } else out += ch;
    }
  }
  function parseNumber() {
    if (peek() === "-") pos++;
    while (pos < text.length && "0123456789.eE+-".includes(text[pos])) pos++;
  }
  function parseValue(path) {
    skipWs();
    const ch = peek();
    const start = pos;
    if (ch === "{") { parseObject(path); spans[path] = { start, end: pos, kind: "object" }; }
    else if (ch === "[") { parseArray(path); spans[path] = { start, end: pos, kind: "array" }; }
    else if (ch === '"') { parseString(); spans[path] = { start, end: pos, kind: "string" }; }
    else if ("-0123456789".includes(ch)) { parseNumber(); spans[path] = { start, end: pos, kind: "number" }; }
    else if (text.startsWith("true", pos)) { pos += 4; spans[path] = { start, end: pos, kind: "bool" }; }
    else if (text.startsWith("false", pos)) { pos += 5; spans[path] = { start, end: pos, kind: "bool" }; }
    else if (text.startsWith("null", pos)) { pos += 4; spans[path] = { start, end: pos, kind: "null" }; }
    else throw new Error(`Unexpected character ${ch} at ${pos}`);
  }
  function parseObject(path) {
    expect("{"); skipWs();
    if (peek() === "}") { pos++; return; }
    for (;;) {
      skipWs();
      const key = parseString();
      skipWs(); expect(":");
      parseValue(`${path}.${key}`);
      skipWs();
      if (peek() === ",") { pos++; continue; }
      expect("}"); return;
    }
  }
  function parseArray(path) {
    expect("["); skipWs();
    if (peek() === "]") { pos++; return; }
    let i = 0;
    for (;;) {
      parseValue(`${path}[${i}]`); i++;
      skipWs();
      if (peek() === ",") { pos++; continue; }
      expect("]"); return;
    }
  }

  skipWs();
  parseValue("$");
  skipWs();
  if (pos !== text.length) throw new Error(`Trailing data at ${pos}`);
  return spans;
}

// ---------- token alignment ----------
// tokens: [{text, logprob, secondLogprob|null}]
function scoreFields(tokens, { leavesOnly = true, stripQuotes = true } = {}) {
  const full = tokens.map(t => t.text).join("");
  // tolerate markdown fences / prose around the JSON object
  const jStart = full.indexOf("{");
  const jEnd = full.lastIndexOf("}") + 1;
  if (jStart < 0 || jEnd <= jStart) throw new Error("No JSON object found in tokens");
  const spansRel = extractValueSpans(full.slice(jStart, jEnd));

  const offsets = [];
  let p = 0;
  for (const t of tokens) { offsets.push([p, p + t.text.length]); p += t.text.length; }

  const out = {};
  for (const [path, span] of Object.entries(spansRel)) {
    if (leavesOnly && (span.kind === "object" || span.kind === "array")) continue;
    let start = span.start + jStart, end = span.end + jStart;
    if (stripQuotes && span.kind === "string" && end - start >= 2) {
      if (start + 1 < end - 1) { start += 1; end -= 1; }
    }
    const lps = [], margins = [], toks = [];
    tokens.forEach((tok, i) => {
      const [ts, te] = offsets[i];
      if (ts < end && te > start) {
        lps.push(tok.logprob);
        toks.push({ text: tok.text, logprob: tok.logprob });
        if (tok.secondLogprob != null) margins.push(tok.logprob - tok.secondLogprob);
      }
    });
    if (!lps.length) continue;
    const mean = lps.reduce((a, b) => a + b, 0) / lps.length;
    const sum = lps.reduce((a, b) => a + b, 0);
    out[path] = {
      path, kind: span.kind, nTokens: lps.length,
      meanLogprob: mean, minLogprob: Math.min(...lps), sumLogprob: sum,
      meanMargin: margins.length ? margins.reduce((a, b) => a + b, 0) / margins.length : null,
      geoProb: Math.exp(mean), minProb: Math.exp(Math.min(...lps)), jointProb: Math.exp(sum),
      tokens: toks,
      rawStart: span.start + jStart, rawEnd: span.end + jStart,
    };
  }
  return { fields: out, fullText: full, jsonStart: jStart, jsonEnd: jEnd };
}

// Accepts: full chat-completion response object, a `choices[0]` object,
// a `logprobs` object, or the `logprobs.content` array directly.
function tokensFromOpenAI(input) {
  let content = input;
  if (content && content.choices) content = content.choices[0];
  if (content && content.logprobs) content = content.logprobs;
  if (content && content.content) content = content.content;
  if (!Array.isArray(content)) throw new Error("Could not find logprobs.content array");
  return content.map(item => {
    let second = null;
    const others = (item.top_logprobs || []).filter(c => c.token !== item.token);
    if (others.length) second = Math.max(...others.map(c => c.logprob));
    return { text: item.token, logprob: item.logprob, secondLogprob: second };
  });
}

// ---------- Wilson threshold ----------
function normPpf(p) {
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
             1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
             6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
             -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
             3.754408661907416e+00];
  const plow = 0.02425, phigh = 1 - plow;
  let q, r;
  if (p < plow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
           ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  }
  if (p > phigh) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
           ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  }
  q = p - 0.5; r = q * q;
  return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q /
         (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
}

function wilsonLowerBound(k, n, delta) {
  if (n === 0) return 0;
  const z = normPpf(1 - delta);
  const phat = k / n;
  const denom = 1 + z * z / n;
  const center = phat + z * z / (2 * n);
  const rad = z * Math.sqrt(phat * (1 - phat) / n + z * z / (4 * n * n));
  return Math.max(0, (center - rad) / denom);
}

// scores: number[], correct: boolean[]
function fitThreshold(scores, correct, targetPrecision = 0.95, delta = 0.05) {
  const idx = scores.map((_, i) => i).sort((a, b) => scores[b] - scores[a]);
  const s = idx.map(i => scores[i]);
  const y = idx.map(i => correct[i]);
  const n = s.length;
  let cum = 0, best = null;
  const curve = []; // for risk-coverage plot
  for (let i = 1; i <= n; i++) {
    cum += y[i - 1] ? 1 : 0;
    const lcb = wilsonLowerBound(cum, i, delta);
    curve.push({ coverage: i / n, precision: cum / i, lcb, score: s[i - 1] });
    if (lcb >= targetPrecision) best = { i, k: cum, lcb };
  }
  if (!best) {
    return { feasible: false, threshold: Infinity, targetPrecision, delta, nCalib: n,
             autoAcceptRate: 0, empiricalPrecision: NaN, precisionLowerBound: 0, curve };
  }
  return {
    feasible: true, threshold: s[best.i - 1], targetPrecision, delta, nCalib: n,
    autoAcceptRate: best.i / n, empiricalPrecision: best.k / best.i,
    precisionLowerBound: best.lcb, curve,
  };
}
