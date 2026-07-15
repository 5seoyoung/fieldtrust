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
      "\nreturn { extractValueSpans, scoreFields, tokensFromOpenAI, wilsonLowerBound, fitThreshold };"
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
