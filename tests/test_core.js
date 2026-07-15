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
      " histogramBins, batchSummary };"
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
// layer 2: jsdom smoke test - PLAN §6(b) scenarios on the booted page
// ---------------------------------------------------------------------------

function bootPage() {
  const { JSDOM } = require("jsdom");
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    url: "https://fieldtrust.test/",
    pretendToBeVisual: true,
  });
  return dom.window;
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
