// Tests for the web app (index.html).
//
// Two layers:
//  1. Pure-core tests - the core <script id="fieldtrust-core"> block is
//     extracted from index.html and evaluated in Node (no DOM). Mirrors
//     the Python tests so both ports stay in sync.
//  2. jsdom smoke test - reproduces the v0 verification scenarios from
//     docs/PLAN.md §6(b): field routing decisions, nested paths, demo-set
//     threshold fit (-0.676 / 23.6% / 95.0%), slider interaction.

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const HTML_PATH = path.join(__dirname, "..", "index.html");
const html = fs.readFileSync(HTML_PATH, "utf8");

// ---------------------------------------------------------------------------
// layer 1: extract & evaluate the core script block
// ---------------------------------------------------------------------------

function loadCore() {
  const m = html.match(/<script id="fieldtrust-core">([\s\S]*?)<\/script>/);
  assert.ok(m, "core script block <script id=\"fieldtrust-core\"> not found");
  const factory = new Function(
    m[1] +
      "\nreturn { extractValueSpans, scoreFields, tokensFromOpenAI, wilsonLowerBound, fitThreshold," +
      " detectMode, segmentSentences, scoreSentences, parseBatch, normalizePath, aggregateByPath," +
      " histogramBins, batchSummary, pathSegments, getByPath, setByPath, reviewQueue, itemKey," +
      " toLabelCsv, parseLabelCsv, toCorrectedJsonl, toPolicyJson, hashText };"
  );
  return factory();
}

const core = loadCore();

test("core: extractValueSpans nested / arrays / escapes / unicode / empty", () => {
  const text =
    '{"a": {"b": [1, "x\\n", "caf\\u00e9"]}, "s": "", "t": true, "n": null, "raw": "카페"}';
  const spans = core.extractValueSpans(text);
  const raw = (p) => text.slice(spans[p].start, spans[p].end);
  assert.equal(raw("$.a.b[0]"), "1");
  assert.equal(raw("$.a.b[1]"), '"x\\n"');
  assert.equal(raw("$.a.b[2]"), '"caf\\u00e9"');
  assert.equal(raw("$.s"), '""');
  assert.equal(raw("$.raw"), '"카페"');
  assert.equal(spans["$.t"].kind, "bool");
  assert.equal(spans["$.n"].kind, "null");
  assert.equal(spans["$.a.b"].kind, "array");
  assert.throws(() => core.extractValueSpans('{"a": 1} junk'));
  assert.throws(() => core.extractValueSpans('{"a": '));
});

function simpleTokens() {
  // {"vendor": "Starbucks", "total": 12.5}
  return [
    { text: '{"', logprob: -0.001 }, { text: "vendor", logprob: -0.001 },
    { text: '":', logprob: -0.001 }, { text: ' "', logprob: -0.002 },
    { text: "Star", logprob: -0.01, secondLogprob: -5.2 },
    { text: "bucks", logprob: -0.02, secondLogprob: -4.8 },
    { text: '",', logprob: -0.001 }, { text: ' "', logprob: -0.001 },
    { text: "total", logprob: -0.001 }, { text: '":', logprob: -0.001 },
    { text: " ", logprob: -0.002 },
    { text: "12", logprob: -0.15, secondLogprob: -2.9 },
    { text: ".5", logprob: -0.25, secondLogprob: -2.1 },
    { text: "}", logprob: -0.001 },
  ];
}

test("core: scoreFields strips quotes and computes per-field stats", () => {
  const { fields } = core.scoreFields(simpleTokens());
  assert.deepEqual(Object.keys(fields).sort(), ["$.total", "$.vendor"]);
  const v = fields["$.vendor"];
  assert.equal(v.nTokens, 2);
  assert.ok(Math.abs(v.meanLogprob - (-0.015)) < 1e-12);
  assert.ok(Math.abs(v.minLogprob - (-0.02)) < 1e-12);
  assert.ok(Math.abs(v.meanMargin - ((5.19 + 4.78) / 2)) < 1e-9);
});

test("core: scoreFields tolerates markdown fences (PLAN §6(b))", () => {
  const fenced = [
    { text: "```", logprob: -0.001 }, { text: "json", logprob: -0.001 },
    { text: "\n", logprob: -0.001 },
    ...simpleTokens(),
    { text: "\n```", logprob: -0.001 },
  ];
  const a = core.scoreFields(fenced).fields;
  const b = core.scoreFields(simpleTokens()).fields;
  assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort());
  for (const p of Object.keys(b)) {
    assert.ok(Math.abs(a[p].meanLogprob - b[p].meanLogprob) < 1e-12);
    assert.equal(a[p].nTokens, b[p].nTokens);
  }
});

test("core: tokensFromOpenAI unwraps full response and finds runner-up", () => {
  const resp = {
    choices: [{
      logprobs: {
        content: [{
          token: "Star", logprob: -0.01,
          top_logprobs: [
            { token: "Star", logprob: -0.01 },
            { token: "Moon", logprob: -4.5 },
          ],
        }],
      },
    }],
  };
  const toks = core.tokensFromOpenAI(resp);
  assert.equal(toks[0].text, "Star");
  assert.equal(toks[0].secondLogprob, -4.5);
});

test("core: wilsonLowerBound reference value wilson(99,100,0.05) ≈ 0.9564", () => {
  assert.ok(Math.abs(core.wilsonLowerBound(99, 100, 0.05) - 0.9564) < 5e-4);
  assert.equal(core.wilsonLowerBound(0, 0, 0.05), 0);
  assert.ok(core.wilsonLowerBound(100, 100, 0.05) < 1);
});

test("core: fitThreshold infeasible target routes everything to review", () => {
  const r = core.fitThreshold([-1, -2, -3], [false, false, false], 0.95, 0.05);
  assert.equal(r.feasible, false);
  assert.equal(r.autoAcceptRate, 0);
  assert.equal(r.threshold, Infinity);
});

// ---------------------------------------------------------------------------
// layer 1b: core additions for Lens free text + Workspace batch (PLAN_v2)
// ---------------------------------------------------------------------------

function proseTokens() {
  return [
    { text: "The", logprob: -0.05 }, { text: " sky", logprob: -0.4 },
    { text: " is", logprob: -0.02 }, { text: " blue", logprob: -1.8 },
    { text: ".", logprob: -0.03 },
    { text: " Rain", logprob: -2.4 }, { text: " falls", logprob: -0.3 },
    { text: ".", logprob: -0.02 },
  ];
}

test("core: detectMode separates structured JSON from free text", () => {
  assert.equal(core.detectMode(simpleTokens()), "structured");
  assert.equal(core.detectMode(proseTokens()), "freetext");
  // an object with no extractable fields is not usable structured input
  assert.equal(core.detectMode([{ text: "{}", logprob: -0.1 }]), "freetext");
});

test("core: segmentSentences splits on terminators but not decimals", () => {
  const spans = core.segmentSentences("A cat sat. It cost 3.50 dollars! Done?");
  const text = "A cat sat. It cost 3.50 dollars! Done?";
  const parts = spans.map(s => text.slice(s.start, s.end).trim());
  assert.deepEqual(parts, ["A cat sat.", "It cost 3.50 dollars!", "Done?"]);
});

test("core: segmentSentences splits on newlines", () => {
  const spans = core.segmentSentences("line one\nline two");
  assert.equal(spans.length, 2);
});

test("core: scoreSentences ranks the shakiest passage last by mean logprob", () => {
  const sents = core.scoreSentences(proseTokens());
  assert.equal(sents.length, 2);
  assert.equal(sents[0].text.trim(), "The sky is blue.");
  // second sentence has the -2.4 token and should score worse
  assert.ok(sents[1].meanLogprob < sents[0].meanLogprob);
  assert.ok(Math.abs(sents[1].minLogprob - (-2.4)) < 1e-12);
  assert.ok(Math.abs(sents[0].geoProb - Math.exp(sents[0].meanLogprob)) < 1e-12);
});

test("core: tokensFromOpenAI exposes ranked alternatives for the heatmap", () => {
  const toks = core.tokensFromOpenAI([{
    token: " July", logprob: -0.9,
    top_logprobs: [
      { token: " June", logprob: -2.6 },
      { token: " July", logprob: -0.9 },
      { token: " August", logprob: -1.4 },
    ],
  }]);
  assert.deepEqual(toks[0].alternatives.map(a => a.text), [" August", " June"]);
  assert.equal(toks[0].secondLogprob, -1.4);
});

test("core: normalizePath collapses array indices", () => {
  assert.equal(core.normalizePath("$.items[0].name"), "$.items[].name");
  assert.equal(core.normalizePath("$.a[10].b[2]"), "$.a[].b[]");
  assert.equal(core.normalizePath("$.date"), "$.date");
});

function batchJSONL() {
  const doc = (id, dateLp) => JSON.stringify({
    id,
    response: { choices: [{ logprobs: { content: [
      { token: '{"v": "', logprob: -0.001 },
      { token: "A", logprob: -0.01 },
      { token: '", "date": "', logprob: -0.001 },
      { token: "2024-02-31", logprob: dateLp },
      { token: '"}', logprob: -0.001 },
    ] } }] },
  });
  return [doc("d1", -2.0), doc("d2", -1.5), "{ not json", doc("d3", -0.1)].join("\n");
}

test("core: parseBatch keeps good lines, collects bad ones", () => {
  const { docs, errors } = core.parseBatch(batchJSONL());
  assert.equal(docs.length, 3);
  assert.deepEqual(docs.map(d => d.id), ["d1", "d2", "d3"]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].line, 3);
  assert.ok(Object.keys(docs[0].fields).includes("$.date"));
});

test("core: parseBatch defaults ids to line numbers and accepts bare responses", () => {
  const bare = JSON.stringify({ choices: [{ logprobs: { content: [
    { token: '{"a": ', logprob: -0.001 }, { token: "1", logprob: -0.2 }, { token: "}", logprob: -0.001 },
  ] } }] });
  const { docs, errors } = core.parseBatch("\n" + bare + "\n");
  assert.equal(errors.length, 0);
  assert.deepEqual(docs.map(d => d.id), ["line-2"]);
});

test("core: aggregateByPath ranks the weakest path first", () => {
  const { docs } = core.parseBatch(batchJSONL());
  const rows = core.aggregateByPath(docs, -0.676);
  assert.equal(rows[0].path, "$.date", "date is the weak field here");
  assert.equal(rows[0].count, 3);
  assert.ok(Math.abs(rows[0].belowRate - 2 / 3) < 1e-12, "2 of 3 dates below threshold");
  assert.equal(rows[1].path, "$.v");
  assert.equal(rows[1].belowRate, 0);
});

test("core: aggregateByPath with no policy reports nothing below threshold", () => {
  const { docs } = core.parseBatch(batchJSONL());
  const rows = core.aggregateByPath(docs, NaN);
  assert.ok(rows.every(r => r.belowCount === 0));
});

test("core: histogramBins covers the range and counts every value", () => {
  const bins = core.histogramBins([-3, -2, -1, 0], 4);
  assert.equal(bins.length, 4);
  assert.equal(bins.reduce((a, b) => a + b.count, 0), 4);
  assert.ok(Math.abs(bins[0].x0 - (-3)) < 1e-12);
  assert.ok(Math.abs(bins[3].x1 - 0) < 1e-12);
  assert.equal(bins[3].count, 1, "max value lands in the last bin, not out of range");
  assert.deepEqual(core.histogramBins([], 4), []);
  assert.equal(core.histogramBins([1, 1, 1], 4).reduce((a, b) => a + b.count, 0), 3);
});

test("core: batchSummary routes everything to review without a policy", () => {
  const { docs } = core.parseBatch(batchJSONL());
  const withPolicy = core.batchSummary(docs, -0.676);
  assert.equal(withPolicy.nDocs, 3);
  assert.equal(withPolicy.nFields, 6);
  assert.equal(withPolicy.nReview, 2);
  assert.equal(withPolicy.nAuto, 4);
  const noPolicy = core.batchSummary(docs, NaN);
  assert.equal(noPolicy.nReview, 6);
  assert.equal(noPolicy.autoAcceptRate, 0);
});

// ---------------------------------------------------------------------------
// layer 1c: core for review queue + exports (PLAN_v2 Sprint 2)
// ---------------------------------------------------------------------------

test("core: pathSegments / getByPath / setByPath round-trip json_spans paths", () => {
  assert.deepEqual(core.pathSegments("$.items[0].name"), ["items", 0, "name"]);
  assert.deepEqual(core.pathSegments("$"), []);
  const obj = { items: [{ name: "Latte" }], date: "2024-02-31" };
  assert.equal(core.getByPath(obj, "$.items[0].name"), "Latte");
  assert.equal(core.getByPath(obj, "$.date"), "2024-02-31");
  assert.equal(core.getByPath(obj, "$.nope.deep"), undefined);
  core.setByPath(obj, "$.items[0].name", "Flat White");
  core.setByPath(obj, "$.date", "2024-02-29");
  assert.equal(obj.items[0].name, "Flat White");
  assert.equal(obj.date, "2024-02-29");
});

test("core: reviewQueue holds only below-threshold fields, riskiest first", () => {
  const { docs } = core.parseBatch(batchJSONL());
  const q = core.reviewQueue(docs, -0.676);
  assert.deepEqual(q.map(i => i.docId), ["d1", "d2"], "d3's date cleared the threshold");
  assert.ok(q[0].score < q[1].score, "worst score first");
  assert.equal(q[0].path, "$.date");
  assert.equal(q[0].value, "2024-02-31", "carries the extracted value for editing");
  assert.ok(q[0].tokens.length, "carries tokens for the popover");
});

test("core: reviewQueue with no feasible policy queues everything", () => {
  const { docs } = core.parseBatch(batchJSONL());
  assert.equal(core.reviewQueue(docs, NaN).length, 6);
});

test("core: toLabelCsv emits only decided rows, approve=1 / edit=0", () => {
  const { docs } = core.parseBatch(batchJSONL());
  const q = core.reviewQueue(docs, -0.676);
  const decisions = {
    [q[0].key]: { action: "edit", value: "2024-02-28" },
    [q[1].key]: { action: "approve" },
  };
  const lines = core.toLabelCsv(q, decisions).trim().split("\n");
  assert.equal(lines[0], "doc_id,field_path,score,correct");
  assert.equal(lines.length, 3);
  assert.match(lines[1], /^d1,\$\.date,-2\.0000\d*,0$/);
  assert.match(lines[2], /^d2,\$\.date,-1\.5000\d*,1$/);
});

test("core: the label CSV review exports feeds straight back into the calibrator", () => {
  // this is the flywheel: PLAN_v2 1.1 / 3.4
  const { docs } = core.parseBatch(batchJSONL());
  const q = core.reviewQueue(docs, NaN);
  const decisions = {};
  q.forEach((it, i) => { decisions[it.key] = { action: i % 2 ? "approve" : "edit", value: "x" }; });
  const csv = core.toLabelCsv(q, decisions);
  const parsed = core.parseLabelCsv(csv);
  assert.equal(parsed.scores.length, q.length, "every exported row is read back");
  assert.equal(parsed.skipped, 0, "the header is not counted as a bad row");
  assert.deepEqual(parsed.correct, q.map((_, i) => !!(i % 2)));
  assert.ok(Math.abs(parsed.scores[0] - q[0].score) < 1e-6);
});

test("core: parseLabelCsv accepts the 2-column form users type", () => {
  const p = core.parseLabelCsv("-0.12,1\n-1.40,0\n-0.03,true\n-2.0,false");
  assert.deepEqual(p.scores, [-0.12, -1.4, -0.03, -2.0]);
  assert.deepEqual(p.correct, [true, false, true, false]);
  assert.equal(p.skipped, 0);
});

test("core: parseLabelCsv honours a named header and counts junk rows", () => {
  const p = core.parseLabelCsv("correct,score\n1,-0.5\nbroken\n0,-2.5");
  assert.deepEqual(p.scores, [-0.5, -2.5], "columns located by name, not position");
  assert.deepEqual(p.correct, [true, false]);
  assert.equal(p.skipped, 1);
  assert.deepEqual(core.parseLabelCsv("").scores, []);
});

test("core: toCorrectedJsonl applies edits and can attach per-field metadata", () => {
  const { docs } = core.parseBatch(batchJSONL());
  const q = core.reviewQueue(docs, -0.676);
  const decisions = { [q[0].key]: { action: "edit", value: "2024-02-28" } };

  const plain = core.toCorrectedJsonl(docs, decisions, {}).trim().split("\n").map(JSON.parse);
  assert.equal(plain.length, 3);
  assert.deepEqual(plain[0], { id: "d1", data: { v: "A", date: "2024-02-28" } }, "edit applied");
  assert.deepEqual(plain[1].data.date, "2024-02-31", "untouched doc keeps its value");
  assert.ok(!("_fieldtrust" in plain[0]), "metadata is opt-in");

  const meta = JSON.parse(core.toCorrectedJsonl(docs, decisions, { meta: true, threshold: -0.676 }).split("\n")[0]);
  assert.equal(meta._fieldtrust["$.date"].decision, "review");
  assert.equal(meta._fieldtrust["$.date"].reviewed, true);
  assert.equal(meta._fieldtrust["$.v"].decision, "auto");
  assert.equal(meta._fieldtrust["$.v"].reviewed, false);
  assert.ok(Math.abs(meta._fieldtrust["$.date"].score - (-2)) < 1e-6);
});

test("core: toCorrectedJsonl does not mutate the loaded batch", () => {
  const { docs } = core.parseBatch(batchJSONL());
  const q = core.reviewQueue(docs, -0.676);
  core.toCorrectedJsonl(docs, { [q[0].key]: { action: "edit", value: "ZZZ" } }, {});
  assert.equal(docs[0].data.date, "2024-02-31", "export builds a copy");
});

test("core: toPolicyJson carries what the python package needs to import", () => {
  const fit = core.fitThreshold([-0.1, -0.2, -3], [true, true, false], 0.8, 0.05);
  const p = JSON.parse(core.toPolicyJson(fit, "2026-07-15T00:00:00.000Z"));
  assert.equal(p.score, "mean_logprob");
  assert.equal(p.targetPrecision, 0.8);
  assert.equal(p.delta, 0.05);
  assert.equal(p.nCalib, 3);
  assert.equal(p.fittedAt, "2026-07-15T00:00:00.000Z");
  assert.equal(typeof p.feasible, "boolean");
  const infeasible = JSON.parse(core.toPolicyJson(
    core.fitThreshold([-1, -2], [false, false], 0.95, 0.05), null));
  assert.equal(infeasible.threshold, null, "no threshold when nothing is feasible");
  assert.equal(infeasible.feasible, false);
});

test("core: hashText is stable and content-sensitive", () => {
  assert.equal(core.hashText("abc"), core.hashText("abc"));
  assert.notEqual(core.hashText("abc"), core.hashText("abd"));
  assert.match(core.hashText(""), /^[0-9a-f]{8}$/);
});

// ---------------------------------------------------------------------------
// layer 2: jsdom smoke test - PLAN §6(b) scenarios on the booted page
// ---------------------------------------------------------------------------

function bootPage(opts) {
  const { JSDOM } = require("jsdom");
  const o = opts || {};
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    url: "https://fieldtrust.test/" + (o.hash || ""),
    pretendToBeVisual: true,
    beforeParse(window) {
      // jsdom has no IndexedDB; inject a fake one only where persistence is
      // under test, so the rest of the suite also proves the app degrades
      // gracefully without storage.
      if (o.idb) {
        window.indexedDB = o.idb;
        window.IDBKeyRange = require("fake-indexeddb/lib/FDBKeyRange");
      }
    },
  });
  return dom.window;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitFor(fn, what, ms = 2000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return;
    await sleep(5);
  }
  throw new Error("timed out waiting for: " + what);
}

test("app: boots with demo response, renders annotated fields incl. nested paths", () => {
  const w = bootPage();
  const paths = [...w.document.querySelectorAll(".val")].map((el) => el.dataset.path);
  assert.ok(paths.includes("$.vendor"));
  assert.ok(paths.includes("$.date"));
  assert.ok(paths.includes("$.items[0].name"), "nested array path rendered");
  assert.ok(paths.includes("$.items[1].qty"));
});

test("app: demo-set threshold fit matches verified values (-0.676 / 23.6% / 95.0%)", () => {
  const w = bootPage();
  const stats = [...w.document.querySelectorAll("#stats .stat b")].map((el) => el.textContent);
  assert.equal(stats[0], "-0.676", "threshold (mean logprob)");
  assert.equal(stats[1], "23.6%", "auto-accept rate");
  assert.equal(stats[3], "95.0%", "precision lower bound");
});

test("app: routing decisions - confident vendor auto-accepted, shaky date reviewed", () => {
  const w = bootPage();
  const cls = (p) => w.document.querySelector(`.val[data-path="${p.replace(/"/g, '\\"')}"]`).className;
  assert.ok(cls("$.vendor").includes("auto"), "$.vendor should be AUTO-ACCEPT");
  assert.ok(cls("$.date").includes("review"), "$.date should be REVIEW");
  const pills = [...w.document.querySelectorAll("#tableWrap .pill")].map((el) => el.textContent);
  assert.ok(pills.includes("AUTO-ACCEPT") && pills.includes("REVIEW"));
});

test("app: target-precision slider refits threshold live", () => {
  const w = bootPage();
  const before = w.document.querySelector("#stats .stat b").textContent;
  const slider = w.document.getElementById("target");
  slider.value = "0.85";
  slider.dispatchEvent(new w.Event("input", { bubbles: true }));
  const after = w.document.querySelector("#stats .stat b").textContent;
  assert.equal(w.document.getElementById("targetOut").textContent, "85%");
  assert.notEqual(after, before, "threshold stat should change when target moves");
});

// ---------------------------------------------------------------------------
// layer 3: PLAN_v2 Sprint 1 - routing, Lens free text, Workspace dashboard
// ---------------------------------------------------------------------------

const on = (w, id) => w.document.getElementById(id).classList.contains("on");

test("app: hash routing shows one view at a time, defaulting to Lens", () => {
  const w = bootPage();
  assert.ok(on(w, "view-lens"), "lens is the default view");
  assert.ok(!on(w, "view-workspace"));
  assert.ok(!on(w, "view-about"));
  const navLens = w.document.querySelector('#nav a[data-view="lens"]');
  assert.equal(navLens.getAttribute("aria-current"), "page");
});

test("app: navigating to #workspace and #about swaps the active view", () => {
  const w = bootPage();
  w.location.hash = "#workspace";
  w.dispatchEvent(new w.Event("hashchange"));
  assert.ok(on(w, "view-workspace"));
  assert.ok(!on(w, "view-lens"));
  assert.equal(w.document.querySelector('#nav a[data-view="workspace"]').getAttribute("aria-current"), "page");

  w.location.hash = "#about";
  w.dispatchEvent(new w.Event("hashchange"));
  assert.ok(on(w, "view-about"));
  assert.ok(!on(w, "view-workspace"));
});

test("app: an unknown hash falls back to Lens", () => {
  const w = bootPage();
  w.location.hash = "#nope";
  w.dispatchEvent(new w.Event("hashchange"));
  assert.ok(on(w, "view-lens"));
});

test("lens: structured results shown for the receipt sample, free text hidden", () => {
  const w = bootPage();
  assert.equal(w.document.getElementById("structuredResults").hidden, false);
  assert.equal(w.document.getElementById("freetextResults").hidden, true);
  assert.match(w.document.getElementById("modeNote").textContent, /auto-detected: structured JSON/);
});

test("lens: routing decisions cite the policy fitted in Workspace", () => {
  const w = bootPage();
  const note = w.document.getElementById("policyNote");
  assert.match(note.textContent, /-0\.676/, "shows the active threshold");
  assert.match(note.textContent, /95%/);
  assert.ok(note.querySelector('a[href="#workspace"]'), "links to where the policy is fitted");
});

function toProse(w) {
  w.document.getElementById("tabProse").dispatchEvent(new w.Event("click", { bubbles: true }));
}

test("lens: prose sample auto-detects free text and renders a token heatmap", () => {
  const w = bootPage();
  toProse(w);
  assert.equal(w.document.getElementById("freetextResults").hidden, false);
  assert.equal(w.document.getElementById("structuredResults").hidden, true);
  assert.match(w.document.getElementById("modeNote").textContent, /auto-detected: free text/);

  const tks = [...w.document.querySelectorAll("#heatmap .tkn")];
  assert.ok(tks.length > 30, "every token is rendered");
  assert.equal(tks.map(t => t.textContent).join(""), "The Apollo 11 mission landed on the Moon on July 20, 1969." +
    " The crew consisted of Neil Armstrong, Buzz Aldrin, and Michael Collins." +
    " The mission lasted approximately 8 days.");
  // banded by probability, with alpha carrying magnitude
  const armstrong = tks.find(t => t.textContent === " Armstrong");
  assert.ok(armstrong.classList.contains("hi"), "a near-certain token is in the confident band");
  const eight = tks.find(t => t.textContent === "8");
  assert.ok(eight.classList.contains("lo"), "a coin-flip token is in the uncertain band");
  assert.ok(parseFloat(eight.style.getPropertyValue("--a")) >
    parseFloat(armstrong.style.getPropertyValue("--a")), "less certain -> more opaque");
});

test("lens: free-text mode makes no accept/review decision (PLAN_v2 2.3)", () => {
  const w = bootPage();
  toProse(w);
  assert.equal(w.document.querySelectorAll("#freetextResults .pill").length, 0);
  assert.equal(w.document.querySelectorAll("#freetextResults .val").length, 0);
});

test("lens: honesty banner states the limit verbatim and is dismissible", () => {
  const w = bootPage();
  toProse(w);
  const banner = w.document.getElementById("honesty");
  assert.equal(banner.hidden, false, "shown on entering free-text mode");
  const t = banner.querySelector(".htext").textContent;
  // wording is fixed by docs/PLAN_v2.md 2.2 - it must stay a limitation notice
  assert.match(t, /A low token probability does not mean .this is wrong./);
  assert.match(t, /there were many ways to word this/);
  assert.match(t, /correlates most strongly with factual errors comes from schema-constrained structured output/);

  assert.ok(banner.querySelector("#honestyStructured"), "offers the structured-mode route out");
  banner.querySelector("#honestyDismiss").dispatchEvent(new w.Event("click", { bubbles: true }));
  assert.equal(banner.hidden, true, "dismissed");
  toProse(w);
  assert.equal(w.document.getElementById("honesty").hidden, true, "stays dismissed for the session");
});

test("lens: token popover exposes the alternatives the model considered", () => {
  const w = bootPage();
  toProse(w);
  const july = [...w.document.querySelectorAll("#heatmap .tkn")].find(t => t.textContent === " July");
  july.dispatchEvent(new w.Event("mouseenter"));
  const pop = w.document.getElementById("pop");
  assert.equal(pop.style.display, "block");
  assert.match(pop.textContent, /" July"/, "chosen token");
  assert.match(pop.textContent, /" June"/, "runner-up the model also considered");
  assert.equal(pop.querySelectorAll(".trow.chosen").length, 1);
  july.dispatchEvent(new w.Event("mouseleave"));
  assert.equal(pop.style.display, "none");
});

test("lens: least certain passages rank the shakiest sentence first", () => {
  const w = bootPage();
  toProse(w);
  const spans = [...w.document.querySelectorAll("#spansWrap .span")];
  assert.equal(spans.length, 3, "bottom 3 sentences");
  assert.match(spans[0].querySelector(".spantext").textContent,
    /The mission lasted approximately 8 days\./, "the 'approximately 8 days' sentence is least certain");
  assert.match(spans[0].querySelector(".spanstat").textContent, /geo \d+\.\d%/);
});

test("lens: manual mode toggle overrides auto-detection", () => {
  const w = bootPage();
  const btn = [...w.document.querySelectorAll("#modeSeg .segbtn")].find(b => b.dataset.mode === "freetext");
  btn.dispatchEvent(new w.Event("click", { bubbles: true }));
  // the receipt is structured JSON, but forced free text renders the heatmap
  assert.equal(w.document.getElementById("freetextResults").hidden, false);
  assert.equal(btn.getAttribute("aria-pressed"), "true");
  assert.match(w.document.getElementById("modeNote").textContent, /forced: free text/);
  assert.ok(w.document.querySelectorAll("#heatmap .tkn").length > 10);
});

function loadDemoBatch(w) {
  w.document.getElementById("loadBatch").dispatchEvent(new w.Event("click", { bubbles: true }));
}

test("workspace: dashboard is empty until a batch is loaded", () => {
  const w = bootPage();
  assert.equal(w.document.getElementById("batchEmpty").hidden, false);
  assert.equal(w.document.getElementById("histCard").hidden, true);
  assert.equal(w.document.getElementById("pathCard").hidden, true);
});

test("workspace: demo batch loads and summarises against the policy", () => {
  const w = bootPage();
  loadDemoBatch(w);
  assert.equal(w.document.getElementById("batchEmpty").hidden, true);
  const stats = [...w.document.querySelectorAll("#batchStats .stat b")].map(e => e.textContent);
  assert.equal(stats[0], "120", "responses");
  assert.equal(stats[1], "480", "fields (4 per receipt)");
  assert.match(stats[2], /^\d+\.\d%$/, "auto-accept rate on this batch");
  assert.match(w.document.getElementById("batchNote").textContent, /120 responses parsed/);
  // the batch rate is computed on the batch, not copied from the calibration set
  const calibRate = w.document.querySelectorAll("#stats .stat b")[1].textContent;
  assert.notEqual(stats[2], calibRate);
});

test("workspace: histogram renders bars and marks the threshold", () => {
  const w = bootPage();
  loadDemoBatch(w);
  assert.equal(w.document.getElementById("histCard").hidden, false);
  const svg = w.document.querySelector("#hist svg");
  assert.ok(svg, "hand-rolled SVG, no chart library");
  assert.ok(svg.querySelectorAll("rect").length >= 20, "one bar per bin");
  assert.match(svg.textContent, /threshold/, "threshold line is labelled");
  // bars are split into auto (teal) and review (red) by the threshold
  const fills = new Set([...svg.querySelectorAll("rect")].map(r => r.getAttribute("fill")));
  assert.ok(fills.has("#0B7A66") && fills.has("#B23A2B"));
});

test("workspace: weakest-field table surfaces $.date as the structural weak spot", () => {
  const w = bootPage();
  loadDemoBatch(w);
  assert.equal(w.document.getElementById("pathCard").hidden, false);
  const rows = [...w.document.querySelectorAll("#pathWrap tbody tr")];
  assert.equal(rows.length, 4, "vendor / date / total / currency");
  assert.equal(rows[0].children[0].textContent, "$.date", "ranked weakest first");
  assert.equal(rows[0].children[1].textContent, "120");
  assert.equal(rows[rows.length - 1].children[0].textContent, "$.currency", "and strongest last");
});

test("workspace: refitting the policy re-decides the loaded batch", () => {
  const w = bootPage();
  loadDemoBatch(w);
  const before = w.document.querySelectorAll("#batchStats .stat b")[2].textContent;
  const slider = w.document.getElementById("target");
  slider.value = "0.80";
  slider.dispatchEvent(new w.Event("input", { bubbles: true }));
  const after = w.document.querySelectorAll("#batchStats .stat b")[2].textContent;
  assert.notEqual(after, before, "a looser target auto-accepts more of the batch");
  assert.ok(parseFloat(after) > parseFloat(before));
});

test("workspace: a batch with only bad lines reports an error and no dashboard", () => {
  const w = bootPage();
  w.document.getElementById("tabBatchPaste").dispatchEvent(new w.Event("click", { bubbles: true }));
  w.document.getElementById("batchIn").value = "not json\nalso not json";
  loadDemoBatch(w);
  const err = w.document.getElementById("batchErr");
  assert.equal(err.style.display, "block");
  assert.match(err.textContent, /No usable responses/);
  assert.equal(w.document.getElementById("histCard").hidden, true);
});

test("workspace: mixed batch skips bad lines and counts them", () => {
  const w = bootPage();
  w.document.getElementById("tabBatchPaste").dispatchEvent(new w.Event("click", { bubbles: true }));
  const good = JSON.stringify({ id: "ok-1", response: { choices: [{ logprobs: { content: [
    { token: '{"a": "', logprob: -0.001 }, { token: "x", logprob: -0.2 }, { token: '"}', logprob: -0.001 },
  ] } }] } });
  w.document.getElementById("batchIn").value = good + "\nbroken line\n" + good;
  loadDemoBatch(w);
  assert.equal(w.document.getElementById("batchErr").style.display, "none");
  assert.match(w.document.getElementById("batchNote").textContent,
    /2 responses parsed · 1 line\(s\) skipped \(first: line 2\)/);
});

// ---------------------------------------------------------------------------
// layer 4: PLAN_v2 Sprint 2 - review queue, persistence, exports, flywheel
// ---------------------------------------------------------------------------

function toWorkspace(w) {
  w.location.hash = "#workspace";
  w.dispatchEvent(new w.Event("hashchange"));
}

function key(w, k, target) {
  (target || w.document).dispatchEvent(new w.KeyboardEvent("keydown", { key: k, bubbles: true }));
}

const rv = (w, sel) => w.document.querySelector("#reviewBody " + sel);
const rvText = (w, sel) => (rv(w, sel) || {}).textContent;

function bootWithBatch(opts) {
  const w = bootPage(opts);
  toWorkspace(w);
  w.document.getElementById("loadBatch").dispatchEvent(new w.Event("click", { bubbles: true }));
  return w;
}

test("review: queue holds only below-threshold fields, riskiest first", () => {
  const w = bootWithBatch();
  assert.equal(w.document.getElementById("reviewCard").hidden, false);
  // 85 of 480 fields fall below the fitted threshold
  assert.match(rvText(w, ".rvprog"), /^0 \/ 85 reviewed$/);
  assert.equal(rvText(w, ".rvpath"), "$.date", "the weakest field surfaces first");
  const conf = rvText(w, ".rvconf");
  assert.match(conf, /geo \d+\.\d%/);
  assert.ok(rv(w, ".rvvalue").textContent.startsWith("2024-"), "shows the extracted value");
});

test("review: 'a' approves the current field and advances to the next", () => {
  const w = bootWithBatch();
  const first = rvText(w, ".rvvalue");
  key(w, "a");
  assert.match(rvText(w, ".rvprog"), /^1 \/ 85 reviewed$/);
  assert.notEqual(rvText(w, ".rvvalue"), first, "moved on");
  assert.match(w.document.querySelector(".rvfill").style.width, /^1\.[0-9]%$/);
});

test("review: 'e' edits inline and Enter records a correction", () => {
  const w = bootWithBatch();
  const path = rvText(w, ".rvpath");
  key(w, "e");
  const input = w.document.getElementById("rvEdit");
  assert.ok(input, "inline editor opened");
  input.value = "2024-02-28";
  key(w, "Enter", input);
  assert.match(rvText(w, ".rvprog"), /^1 \/ 85 reviewed$/);
  // the correction is an implicit "this was wrong" label
  const csv = w.eval("toLabelCsv(state.review.items, state.review.decisions)");
  assert.match(csv.split("\n")[1], new RegExp(`,\\${path},.*,0$`));
});

test("review: an edit that is not valid JSON for a non-string field is rejected", () => {
  const w = bootWithBatch();
  // walk to a number field ($.total is the only non-string in this batch)
  w.eval('state.review.idx = state.review.items.findIndex(i => i.kind === "number"); renderReview();');
  assert.equal(w.eval("state.review.items[state.review.idx].kind"), "number");
  key(w, "e");
  const input = w.document.getElementById("rvEdit");
  input.value = "not a number";
  key(w, "Enter", input);
  assert.equal(w.document.getElementById("rvEditErr").style.display, "block");
  assert.match(rvText(w, ".rvprog"), /^0 \/ 85 reviewed$/, "nothing recorded");
  // a real number is accepted and stays a number
  input.value = "18.4";
  key(w, "Enter", input);
  assert.equal(w.eval("Object.values(state.review.decisions)[0].value"), 18.4);
});

test("review: j/k move through the queue without deciding", () => {
  const w = bootWithBatch();
  assert.match(rvText(w, ".rvpos"), /^1 of 85 in queue/);
  key(w, "j"); key(w, "j");
  assert.match(rvText(w, ".rvpos"), /^3 of 85 in queue/);
  key(w, "k");
  assert.match(rvText(w, ".rvpos"), /^2 of 85 in queue/);
  assert.match(rvText(w, ".rvprog"), /^0 \/ 85 reviewed$/, "moving is not deciding");
  key(w, "k"); key(w, "k");
  assert.match(rvText(w, ".rvpos"), /^1 of 85 in queue/, "clamped at the top");
});

test("review: 'u' undoes the last decision", () => {
  const w = bootWithBatch();
  const first = rvText(w, ".rvvalue");
  key(w, "a");
  key(w, "a");
  assert.match(rvText(w, ".rvprog"), /^2 \/ 85 reviewed$/);
  key(w, "u");
  assert.match(rvText(w, ".rvprog"), /^1 \/ 85 reviewed$/);
  key(w, "u");
  assert.match(rvText(w, ".rvprog"), /^0 \/ 85 reviewed$/);
  assert.equal(rvText(w, ".rvvalue"), first, "cursor returns to the undone item");
  key(w, "u");   // empty history
  assert.match(rvText(w, ".rvprog"), /^0 \/ 85 reviewed$/);
});

test("review: shortcuts stay out of the way while typing", () => {
  const w = bootWithBatch();
  const ta = w.document.getElementById("batchIn");
  key(w, "a", ta);
  assert.match(rvText(w, ".rvprog"), /^0 \/ 85 reviewed$/, "'a' in a textarea is just text");
  // and they are scoped to Workspace
  w.location.hash = "#lens";
  w.dispatchEvent(new w.Event("hashchange"));
  key(w, "a");
  assert.match(rvText(w, ".rvprog"), /^0 \/ 85 reviewed$/);
});

test("review: clearing the queue reports what was reviewed vs auto-accepted", () => {
  const w = bootWithBatch();
  w.eval("state.review.items.forEach(i => state.review.decisions[i.key] = {action:'approve'}); renderReview();");
  const done = rvText(w, ".rvdone");
  assert.match(done, /Queue cleared/);
  // PLAN_v2 3.3: "reviewed 118 of 2,340 fields (5.0%), the rest auto-accepted"
  assert.match(done, /You reviewed\s*85\s*of 480 fields \(17\.7%\)/);
  assert.match(done, /The other 395 auto-accepted with precision guaranteed at\s*≥\s*95%/);
  assert.match(done, /85 approved · 0 corrected/);
});

test("review: the done screen refits the threshold from the review labels (flywheel)", () => {
  const w = bootWithBatch();
  // approve most, correct a few - a realistic label set
  w.eval(`state.review.items.forEach((i, n) => state.review.decisions[i.key] =
    n % 4 === 0 ? {action:'edit', value:'x'} : {action:'approve'}); renderReview();`);
  const before = w.document.querySelector("#stats .stat b").textContent;

  w.document.getElementById("rvRefit").dispatchEvent(new w.Event("click", { bubbles: true }));

  const csv = w.document.getElementById("csvIn").value;
  assert.match(csv.split("\n")[0], /^doc_id,field_path,score,correct$/);
  assert.ok(w.document.getElementById("tabCsv").classList.contains("on"), "switched to the CSV source");
  assert.equal(w.document.getElementById("csvErr").style.display, "none",
    "the exported 4-column CSV is accepted as-is");
  assert.notEqual(w.document.querySelector("#stats .stat b").textContent, before,
    "the policy was refitted from the review labels");
  assert.equal(w.eval("state.fit.nCalib"), 85);
});

test("export: the three files are built from what is loaded", () => {
  const w = bootWithBatch();
  w.eval("download = (name, text, mime) => { window.__dl = {name, text, mime}; };");
  key(w, "e");
  const input = w.document.getElementById("rvEdit");
  input.value = "2024-02-28";
  key(w, "Enter", input);

  w.document.getElementById("expJsonl").dispatchEvent(new w.Event("click", { bubbles: true }));
  let dl = w.__dl;
  assert.equal(dl.name, "fieldtrust-corrected.jsonl");
  const rows = dl.text.trim().split("\n").map(JSON.parse);
  assert.equal(rows.length, 120);
  assert.ok(rows.some(r => r.data.date === "2024-02-28"), "the correction is in the file");
  assert.ok(rows[0]._fieldtrust, "metadata attached when the box is checked");

  w.document.getElementById("exportMeta").checked = false;
  w.document.getElementById("expJsonl").dispatchEvent(new w.Event("click", { bubbles: true }));
  assert.ok(!JSON.parse(w.__dl.text.split("\n")[0])._fieldtrust, "and omitted when it is not");

  w.document.getElementById("expLabels").dispatchEvent(new w.Event("click", { bubbles: true }));
  assert.equal(w.__dl.name, "fieldtrust-labels.csv");
  assert.equal(w.__dl.text.trim().split("\n").length, 2, "header + the one decision");

  w.document.getElementById("expPolicy").dispatchEvent(new w.Event("click", { bubbles: true }));
  assert.equal(w.__dl.name, "fieldtrust-policy.json");
  const policy = JSON.parse(w.__dl.text);
  assert.ok(Math.abs(policy.threshold - (-0.676)) < 5e-4);
  assert.equal(policy.targetPrecision, 0.95);
  assert.ok(policy.fittedAt, "stamped when the policy was fitted");
});

test("review: a refit re-cuts the queue but keeps decisions on fields still in it", () => {
  const w = bootWithBatch();
  key(w, "a");                       // approves the riskiest field
  assert.match(rvText(w, ".rvprog"), /^1 \/ 85 reviewed$/);
  const slider = w.document.getElementById("target");
  slider.value = "0.90";             // looser target -> threshold -1.470 -> 8 left
  slider.dispatchEvent(new w.Event("input", { bubbles: true }));
  assert.match(rvText(w, ".rvprog"), /^1 \/ 8 reviewed$/,
    "queue re-cut, and the riskiest field is still in it and still approved");
});

test("review: a policy loose enough to accept the whole batch empties the queue", () => {
  const w = bootWithBatch();
  const slider = w.document.getElementById("target");
  slider.value = "0.80";             // threshold -1.757: nothing in this batch is below it
  slider.dispatchEvent(new w.Event("input", { bubbles: true }));
  assert.equal(w.eval("state.review.items.length"), 0);
  assert.match(rvText(w, ".empty"), /every field in this batch cleared the threshold/);
  assert.equal(w.document.querySelectorAll("#batchStats .stat b")[2].textContent, "100.0%");
});

test("review: with storage unavailable the queue still works, just without resume", () => {
  const w = bootWithBatch();          // no idb injected
  assert.equal(w.document.getElementById("resumeBar").hidden, true);
  key(w, "a");
  assert.match(rvText(w, ".rvprog"), /^1 \/ 85 reviewed$/, "review is not blocked by storage");
});

test("review: progress survives a reload and can be resumed (D-004)", async () => {
  const FDBFactory = require("fake-indexeddb/lib/FDBFactory");
  const idb = new FDBFactory();

  const w1 = bootWithBatch({ idb });
  key(w1, "a");
  key(w1, "a");
  key(w1, "a");
  assert.match(rvText(w1, ".rvprog"), /^3 \/ 85 reviewed$/);
  await waitFor(() => w1.eval("state.review.decisions") && true, "decisions recorded");
  await sleep(80);                       // let the IndexedDB write land

  // a fresh window over the same storage is what a browser reload looks like
  const w2 = bootWithBatch({ idb });
  const bar = w2.document.getElementById("resumeBar");
  await waitFor(() => !bar.hidden, "resume bar to appear");
  assert.match(bar.textContent, /You reviewed 3 field\(s\) in this batch/);
  assert.match(rvText(w2, ".rvprog"), /^0 \/ 85 reviewed$/, "not resumed until asked");

  w2.document.getElementById("resumeYes").dispatchEvent(new w2.Event("click", { bubbles: true }));
  assert.match(rvText(w2, ".rvprog"), /^3 \/ 85 reviewed$/, "picked up where it left off");
  assert.equal(bar.hidden, true);
  assert.match(w2.document.querySelectorAll("#batchStats .stat b")[3].textContent, /^3 \/ 85$/);
});

test("review: 'start over' drops the saved session (D-004)", async () => {
  const FDBFactory = require("fake-indexeddb/lib/FDBFactory");
  const idb = new FDBFactory();

  const w1 = bootWithBatch({ idb });
  key(w1, "a");
  await sleep(80);

  const w2 = bootWithBatch({ idb });
  await waitFor(() => !w2.document.getElementById("resumeBar").hidden, "resume bar");
  w2.document.getElementById("resumeNo").dispatchEvent(new w2.Event("click", { bubbles: true }));
  await sleep(80);
  assert.match(rvText(w2, ".rvprog"), /^0 \/ 85 reviewed$/);

  const w3 = bootWithBatch({ idb });
  await sleep(120);
  assert.equal(w3.document.getElementById("resumeBar").hidden, true, "nothing left to resume");
});

test("acceptance: upload -> review -> export -> refit runs end to end (PLAN_v2 5)", async () => {
  const FDBFactory = require("fake-indexeddb/lib/FDBFactory");
  const idb = new FDBFactory();

  // upload
  const w1 = bootWithBatch({ idb });
  assert.equal(w1.eval("state.batch.docs.length"), 120);
  // review a few, then reload mid-way
  key(w1, "a"); key(w1, "e");
  const input = w1.document.getElementById("rvEdit");
  input.value = "2024-02-28";
  key(w1, "Enter", input);
  await sleep(80);

  const w = bootWithBatch({ idb });
  await waitFor(() => !w.document.getElementById("resumeBar").hidden, "resume offered");
  w.document.getElementById("resumeYes").dispatchEvent(new w.Event("click", { bubbles: true }));
  assert.match(rvText(w, ".rvprog"), /^2 \/ 85 reviewed$/, "review survived the reload");

  // finish the queue
  w.eval(`state.review.items.forEach(i => { if (!state.review.decisions[i.key])
    state.review.decisions[i.key] = {action:'approve'}; }); renderReview();`);
  assert.match(rvText(w, ".rvdone"), /Queue cleared/);

  // export
  w.eval("download = (name, text) => { window.__dl = {name, text}; };");
  w.document.getElementById("expLabels").dispatchEvent(new w.Event("click", { bubbles: true }));
  assert.equal(w.__dl.text.trim().split("\n").length, 86, "header + 85 labels");

  // refit from those labels, in one click
  w.document.getElementById("rvRefit").dispatchEvent(new w.Event("click", { bubbles: true }));
  assert.equal(w.document.getElementById("csvErr").style.display, "none");
  assert.equal(w.eval("state.fit.nCalib"), 85);
});

test("export: the panel note tracks review decisions as they happen", () => {
  const w = bootWithBatch();
  const note = () => w.document.getElementById("exportNote").textContent;
  assert.match(note(), /No review decisions yet/);
  key(w, "a");
  assert.match(note(), /^1 decision\(s\) will be applied\.$/, "stale note would misreport the export");
  key(w, "a");
  assert.match(note(), /^2 decision\(s\)/);
  key(w, "u");
  assert.match(note(), /^1 decision\(s\)/, "undo is reflected too");
});
