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
    // `alternatives` keeps the full runner-up list for the free-text lens,
    // which shows what else the model considered at this position.
    const alternatives = others
      .map(c => ({ text: c.token, logprob: c.logprob }))
      .sort((a, b) => b.logprob - a.logprob);
    return { text: item.token, logprob: item.logprob, secondLogprob: second, alternatives };
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

// ---------- lens mode detection ----------
// Structured mode needs a JSON object we can actually pull fields out of;
// anything else (prose, refusals, chain-of-thought) is free text.
function detectMode(tokens) {
  try {
    return Object.keys(scoreFields(tokens).fields).length ? "structured" : "freetext";
  } catch (e) {
    return "freetext";
  }
}

// ---------- free-text scoring ----------
// Char spans of sentence-ish chunks: split after . ! ? or on newlines.
function segmentSentences(text) {
  const out = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const isBreak = ch === "\n" || ((ch === "." || ch === "!" || ch === "?") &&
      // not a decimal point / ellipsis mid-number
      !/[0-9]/.test(text[i + 1] || ""));
    if (!isBreak) continue;
    let end = i + 1;
    while (end < text.length && ".!?\"')]".includes(text[end])) end++;
    if (text.slice(start, end).trim()) out.push({ start, end });
    start = end;
  }
  if (text.slice(start).trim()) out.push({ start, end: text.length });
  return out;
}

// Per-sentence aggregate logprobs, for ranking the shakiest passages.
function scoreSentences(tokens) {
  const full = tokens.map(t => t.text).join("");
  const offsets = [];
  let p = 0;
  for (const t of tokens) { offsets.push([p, p + t.text.length]); p += t.text.length; }

  return segmentSentences(full).map(({ start, end }) => {
    const lps = [], toks = [];
    tokens.forEach((tok, i) => {
      const [ts, te] = offsets[i];
      if (ts < end && te > start) { lps.push(tok.logprob); toks.push(tok); }
    });
    if (!lps.length) return null;
    const sum = lps.reduce((a, b) => a + b, 0);
    return {
      text: full.slice(start, end), start, end, nTokens: lps.length,
      meanLogprob: sum / lps.length, minLogprob: Math.min(...lps),
      geoProb: Math.exp(sum / lps.length), tokens: toks,
    };
  }).filter(Boolean);
}

// ---------- batch (JSONL) ----------
// Each line is either a bare OpenAI response or {id, response}. Bad lines are
// collected rather than thrown, so one broken row cannot kill a 500-row batch.
function parseBatch(text) {
  const docs = [], errors = [];
  text.split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    try {
      const obj = JSON.parse(line);
      const response = obj && obj.response ? obj.response : obj;
      const id = (obj && obj.id != null) ? String(obj.id) : `line-${i + 1}`;
      const tokens = tokensFromOpenAI(response);
      const { fields, fullText, jsonStart, jsonEnd } = scoreFields(tokens);
      if (!Object.keys(fields).length) throw new Error("no JSON fields found");
      docs.push({
        id, line: i + 1, tokens, fields,
        // the extracted object itself - what review edits and export emits
        data: JSON.parse(fullText.slice(jsonStart, jsonEnd)),
        // optional source text, shown next to the field during review
        context: (obj && (obj.context || obj.source_text)) || null,
      });
    } catch (e) {
      errors.push({ line: i + 1, message: e.message });
    }
  });
  return { docs, errors };
}

// $.items[0].name -> $.items[].name, so array elements aggregate together.
function normalizePath(path) {
  return path.replace(/\[\d+\]/g, "[]");
}

// Per-path rollup: which field of your schema is structurally weak?
function aggregateByPath(docs, threshold) {
  const byPath = new Map();
  for (const doc of docs) {
    for (const f of Object.values(doc.fields)) {
      const key = normalizePath(f.path);
      if (!byPath.has(key)) byPath.set(key, []);
      byPath.get(key).push(f);
    }
  }
  const rows = [];
  for (const [path, fs] of byPath) {
    const sum = fs.reduce((a, f) => a + f.meanLogprob, 0);
    const below = Number.isFinite(threshold)
      ? fs.filter(f => f.meanLogprob < threshold).length : 0;
    rows.push({
      path, count: fs.length,
      meanLogprob: sum / fs.length,
      meanGeoProb: fs.reduce((a, f) => a + f.geoProb, 0) / fs.length,
      minGeoProb: Math.min(...fs.map(f => f.geoProb)),
      belowCount: below, belowRate: below / fs.length,
    });
  }
  // weakest first: most below-threshold, then lowest confidence
  return rows.sort((a, b) => b.belowRate - a.belowRate || a.meanLogprob - b.meanLogprob);
}

// Confidence buckets, not equal-width bins.
//
// Real extraction scores are not spread out: on a captured batch 73% of fields
// sit at exactly logprob 0 and the rest trail off to about -0.8. Equal-width
// bins put ~95% of the mass in one bar and hide the threshold inside it, which
// is worse than useless - the chart said "all review" while the batch was 93%
// auto-accept. These edges spend their resolution where the decision is.
const CONF_EDGES = [0, 0.5, 0.8, 0.9, 0.95, 0.99, 0.999, 1];

// Each bucket is split by the policy, so a bucket the threshold cuts through
// shows both parts instead of being forced into one colour.
function confidenceBuckets(fields, threshold) {
  const buckets = [];
  for (let i = 0; i < CONF_EDGES.length - 1; i++) {
    buckets.push({ lo: CONF_EDGES[i], hi: CONF_EDGES[i + 1], auto: 0, review: 0, count: 0 });
  }
  for (const f of fields) {
    const p = Math.exp(f.meanLogprob);
    let i = buckets.findIndex(b => p < b.hi);
    if (i < 0) i = buckets.length - 1;          // p === 1 lands in the top bucket
    const b = buckets[i];
    b.count++;
    if (Number.isFinite(threshold) && f.meanLogprob >= threshold) b.auto++; else b.review++;
  }
  return buckets;
}

// Rollup of a batch against the current policy.
function batchSummary(docs, threshold) {
  let nFields = 0, nBelow = 0;
  for (const doc of docs) {
    for (const f of Object.values(doc.fields)) {
      nFields++;
      if (!Number.isFinite(threshold) || f.meanLogprob < threshold) nBelow++;
    }
  }
  return {
    nDocs: docs.length, nFields, nReview: nBelow, nAuto: nFields - nBelow,
    autoAcceptRate: nFields ? (nFields - nBelow) / nFields : 0,
  };
}

// ---------- JSONPath access ----------
// Mirrors the paths json_spans emits ($.a.b[0]). Keys containing "." or "["
// are ambiguous here exactly as they are in the parser - a shared limitation,
// not a new one.
function pathSegments(path) {
  const segs = [];
  const re = /\.([^.[\]]+)|\[(\d+)\]/g;
  let m;
  while ((m = re.exec(path))) segs.push(m[1] !== undefined ? m[1] : Number(m[2]));
  return segs;
}

function getByPath(obj, path) {
  let cur = obj;
  for (const s of pathSegments(path)) {
    if (cur == null) return undefined;
    cur = cur[s];
  }
  return cur;
}

function setByPath(obj, path, value) {
  const segs = pathSegments(path);
  if (!segs.length) return value;
  let cur = obj;
  for (let i = 0; i < segs.length - 1; i++) {
    if (cur[segs[i]] == null) cur[segs[i]] = typeof segs[i + 1] === "number" ? [] : {};
    cur = cur[segs[i]];
  }
  cur[segs[segs.length - 1]] = value;
  return obj;
}

// ---------- review queue ----------
const itemKey = (docId, path) => docId + " " + path;

// Fraction of every batch that is labelled for calibration, drawn without
// looking at which side of the threshold a field fell on. ~2% extra review;
// it is what keeps the whole guarantee honest (docs/DECISIONS.md D-007).
const AUDIT_RATE = 0.02;

// Deterministic uniform draw in [0,1) from a field's identity, so the audit
// sample survives a reload and cannot be re-rolled until it looks good.
function sampleU(key) {
  return parseInt(hashText(key), 16) / 4294967296;
}

// The queue is two things that must not be confused:
//
//   correction  - every field below the threshold. This is the work.
//   calibration - a uniform AUDIT_RATE sample of ALL fields, drawn regardless
//                 of the decision. This is the evidence.
//
// Labels from the correction queue are a censored sample (everything in it is
// by construction below the threshold), so fitting on them estimates precision
// from the tail and freezes the policy - measured on real data, six batches of
// review labels moved the threshold not at all, while a uniform 2% sample let
// it fall from -0.0205 to -0.0403. Only the uniform sample is i.i.d., so only
// it may be fed back to the calibrator. See docs/DECISIONS.md D-007.
function reviewQueue(docs, threshold, auditRate = AUDIT_RATE) {
  const correction = [], audit = [];
  for (const doc of docs) {
    for (const f of Object.values(doc.fields)) {
      const key = itemKey(doc.id, f.path);
      const below = !Number.isFinite(threshold) || f.meanLogprob < threshold;
      const inSample = sampleU(key) < auditRate;
      if (!below && !inSample) continue;          // auto-accepted and not audited
      const item = {
        key, docId: doc.id, path: f.path, kind: f.kind,
        value: getByPath(doc.data, f.path), score: f.meanLogprob,
        geoProb: f.geoProb, minProb: f.minProb, tokens: f.tokens,
        context: doc.context,
        isAudit: !below,        // pulled from the auto-accept side by the sample
        inCalib: inSample,      // part of the uniform calibration sample
      };
      (below ? correction : audit).push(item);
    }
  }
  correction.sort((a, b) => a.score - b.score || (a.docId < b.docId ? -1 : 1));

  // Interleave audits rather than append them: sorted by score they would all
  // land at the end, so stopping early would skip the sample, and a reviewer
  // who noticed the pattern would rubber-stamp them.
  const out = correction.slice();
  for (const a of audit) {
    const pos = Math.floor(sampleU(a.key + "#pos") * (out.length + 1));
    out.splice(pos, 0, a);
  }
  return out;
}

// The calibration sample: uniform and decision-blind, so poolable with any
// earlier uniform sample and valid under plain Wilson.
function calibRows(items, decisions) {
  const rows = [];
  for (const it of items) {
    const d = decisions[it.key];
    if (!it.inCalib || !d) continue;
    rows.push({ score: it.score, correct: d.action === "approve" });
  }
  return rows;
}

// Is the guarantee still holding in production? Measured only on audited
// auto-accepts - the one unbiased read we have of the region we promised.
function auditPrecision(items, decisions) {
  let n = 0, ok = 0;
  for (const it of items) {
    const d = decisions[it.key];
    if (!it.isAudit || !d) continue;
    n++;
    if (d.action === "approve") ok++;
  }
  return { n, correct: ok, precision: n ? ok / n : NaN };
}

// ---------- label CSV ----------
// Below this a Wilson bound is too wide to be worth fitting, so the calibrator
// refuses rather than issuing a guarantee it cannot support.
const MIN_CALIB_ROWS = 20;

function csvCell(v) {
  const s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// Reviewing produces exactly the labels calibration needs: approve = the value
// was right (1), edit = it was wrong (0). This is what closes the loop.
function toLabelCsv(items, decisions) {
  const rows = ["doc_id,field_path,score,correct"];
  for (const it of items) {
    const d = decisions[it.key];
    if (!d) continue;
    rows.push([csvCell(it.docId), csvCell(it.path), it.score.toFixed(6),
               d.action === "approve" ? 1 : 0].join(","));
  }
  return rows.join("\n") + "\n";
}

// Accepts both the 2-column form a user types (`score,correct`) and the
// 4-column form review exports (`doc_id,field_path,score,correct`), with or
// without a header - otherwise the flywheel would need a manual edit step.
function parseLabelCsv(text) {
  const rows = text.trim().split(/\r?\n+/)
    .map(l => l.split(/[,\t]/).map(c => c.trim().replace(/^"|"$/g, "")))
    .filter(r => r.length && r.some(c => c !== ""));
  if (!rows.length) return { scores: [], correct: [], skipped: 0 };

  let si = -1, ci = -1, start = 0;
  const head = rows[0].map(h => h.toLowerCase());
  if (head.includes("score") && (head.includes("correct") || head.includes("label"))) {
    si = head.indexOf("score");
    ci = head.includes("correct") ? head.indexOf("correct") : head.indexOf("label");
    start = 1;
  }

  const scores = [], correct = [];
  let skipped = 0;
  for (let i = start; i < rows.length; i++) {
    const r = rows[i];
    // no header: the last two columns are score,correct in both layouts
    const s = si >= 0 ? r[si] : r[r.length - 2];
    const c = ci >= 0 ? r[ci] : r[r.length - 1];
    const sc = parseFloat(s);
    const cc = /^(1|true|yes)$/i.test(String(c)) ? 1 : /^(0|false|no)$/i.test(String(c)) ? 0 : NaN;
    if (isNaN(sc) || isNaN(cc)) { skipped++; continue; }
    scores.push(sc); correct.push(!!cc);
  }
  return { scores, correct, skipped };
}

// ---------- exports ----------
// Corrected extractions, not the OpenAI envelope: re-emitting logprobs would
// be bloat nobody consumes.
function toCorrectedJsonl(docs, decisions, opts) {
  const o = opts || {};
  return docs.map(doc => {
    const data = JSON.parse(JSON.stringify(doc.data));
    const meta = {};
    for (const f of Object.values(doc.fields)) {
      const d = decisions[itemKey(doc.id, f.path)];
      if (d && d.action === "edit") setByPath(data, f.path, d.value);
      if (o.meta) meta[f.path] = {
        score: Number(f.meanLogprob.toFixed(6)),
        decision: Number.isFinite(o.threshold) && f.meanLogprob >= o.threshold ? "auto" : "review",
        reviewed: !!d,
      };
    }
    const out = { id: doc.id, data };
    if (o.meta) out._fieldtrust = meta;
    return JSON.stringify(out);
  }).join("\n") + "\n";
}

function toPolicyJson(fit, fittedAt) {
  return JSON.stringify({
    threshold: fit && fit.feasible ? Number(fit.threshold.toFixed(6)) : null,
    targetPrecision: fit ? fit.targetPrecision : null,
    delta: fit ? fit.delta : null,
    nCalib: fit ? fit.nCalib : 0,
    feasible: !!(fit && fit.feasible),
    score: "mean_logprob",
    fittedAt: fittedAt || null,
  }, null, 2) + "\n";
}

// ---------- batch identity ----------
// FNV-1a. Identifies a batch so a reload can offer to resume its session.
function hashText(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
