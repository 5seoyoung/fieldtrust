#!/usr/bin/env node
// Captures every demo fixture from a real model, so nothing the landing page
// shows is invented by us. Writes src/fixtures.js; run `npm run build` after.
//
//   OPENAI_API_KEY=... node scripts/capture-demo.js
//   node scripts/capture-demo.js            # falls back to ~/.config/fieldtrust/openai.key
//
// The key is never written to the output and must never be committed.
//
// What is real here and what is not (docs/DEMO_DATA.md has the long version):
//   real  - every probability, every extraction, every correct/incorrect label
//   ours  - the receipts themselves, and which fields we destroyed. We author
//           those precisely so ground truth is known: a destroyed field cannot
//           be read, so whatever the model emits for it is invented, and the
//           label is 0. That is what makes an honest calibration set possible
//           without hand-labelling hundreds of rows.

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const MODEL = "gpt-4o-mini";
const N_CALIB = 60;          // ~8 fields each -> ~480 labelled rows
// The batch is disjoint from the calibration set (different seeds) and big
// enough that its review queue clears the calibrator's 20-row minimum -
// otherwise the demo can review but not refit, and the flywheel is unshowable.
const N_BATCH = 60;
const CONCURRENCY = 6;
const OUT = path.join(__dirname, "..", "src", "fixtures.js");

function readKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY.trim();
  const f = path.join(os.homedir(), ".config", "fieldtrust", "openai.key");
  if (fs.existsSync(f)) return fs.readFileSync(f, "utf8").trim();
  console.error("No API key. Set OPENAI_API_KEY or write ~/.config/fieldtrust/openai.key");
  process.exit(1);
}
const KEY = readKey();

const SCHEMA = "vendor, date (ISO 8601 date only), total (number), currency, items (array of {name, qty})";
const promptFor = r => `Extract this receipt as JSON with keys: ${SCHEMA}.\n\n${r}`;

async function call(body, tries = 4) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + KEY },
      body: JSON.stringify({ model: MODEL, logprobs: true, top_logprobs: 2, ...body }),
    });
    const j = await r.json();
    if (!j.error) return j;
    if (i === tries - 1) throw new Error(j.error.message);
    await new Promise(s => setTimeout(s, 2000 * (i + 1)));
  }
}
const extract = text => call({
  messages: [{ role: "user", content: promptFor(text) }],
  response_format: { type: "json_object" }, temperature: 0,
});

const round = x => Number(x.toFixed(4));
function slim(resp, keepAlts) {
  return { choices: [{ logprobs: { content: resp.choices[0].logprobs.content.map(t => {
    const o = { token: t.token, logprob: round(t.logprob) };
    if (keepAlts && t.top_logprobs) o.top_logprobs = t.top_logprobs.map(a => ({ token: a.token, logprob: round(a.logprob) }));
    return o;
  }) } }] };
}

// ---------------------------------------------------------------------------
// receipts with known ground truth
// ---------------------------------------------------------------------------
function rng(seed) { return () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; }

const VENDORS = ["BLUE BOTTLE COFFEE", "STARBUCKS", "PEETS COFFEE", "CAFE VERVE", "SIGHTGLASS COFFEE", "TIM HORTONS"];
const ITEMS = [["Latte", 5.75], ["Cappuccino", 5.25], ["Blueberry Muffin", 3.50], ["Croissant", 4.25], ["Cold Brew", 4.95]];

// `destroy` marks a field unreadable. Illegible characters are the honest way
// to force a guess: the model cannot recover what is not on the paper.
function makeReceipt(i) {
  const r = rng(i * 7919 + 13);
  const vendor = VENDORS[Math.floor(r() * VENDORS.length)];
  const [n1, p1] = ITEMS[Math.floor(r() * ITEMS.length)];
  const [n2, p2] = ITEMS[Math.floor(r() * ITEMS.length)];
  const q1 = 1 + Math.floor(r() * 2), q2 = 1 + Math.floor(r() * 3);
  const total = Number((p1 * q1 + p2 * q2).toFixed(2));
  const mm = String(1 + Math.floor(r() * 12)).padStart(2, "0");
  const dd = String(1 + Math.floor(r() * 28)).padStart(2, "0");

  // roughly a third of receipts arrive with something unreadable
  const destroy = { date: r() < 0.35, total: r() < 0.18, vendor: r() < 0.12 };

  const text = [
    destroy.vendor ? vendor.replace(/[AEOU]/g, "#") : vendor,
    "Ferry Building, San Francisco",
    "",
    `${q1}x ${n1}`.padEnd(26) + p1.toFixed(2),
    `${q2}x ${n2}`.padEnd(26) + p2.toFixed(2),
    "-".repeat(32),
    "TOTAL".padEnd(26) + (destroy.total ? "##.##" : total.toFixed(2)),
    "Card ****4021",
    (destroy.date ? "##/##/##" : `${mm}/${dd}/24`) + "   09:14",
  ].join("\n");

  // a destroyed field has no truth: anything the model emits for it is wrong
  const truth = {
    "$.vendor": destroy.vendor ? null : vendor,
    "$.date": destroy.date ? null : `2024-${mm}-${dd}`,
    "$.total": destroy.total ? null : total,
    "$.currency": "USD",
    "$.items[0].name": n1, "$.items[0].qty": q1,
    "$.items[1].name": n2, "$.items[1].qty": q2,
  };
  return { id: `doc-${i + 1}`, text, truth, destroy };
}

const norm = v => String(v).toUpperCase().replace(/\s+/g, " ").trim();
function isCorrect(path, value, truth) {
  if (!(path in truth)) return null;          // model invented a field we cannot judge
  const t = truth[path];
  if (t === null) return false;               // unreadable in the source -> invented
  if (typeof t === "number") return Math.abs(Number(value) - t) < 1e-6;
  return norm(value) === norm(t);
}

// ---------------------------------------------------------------------------
async function pool(items, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    out.push(...await Promise.all(items.slice(i, i + CONCURRENCY).map(fn)));
    process.stdout.write(".");
  }
  return out;
}

(async () => {
  const core = new Function(fs.readFileSync(path.join(__dirname, "..", "src", "core.js"), "utf8")
    + "\nreturn { scoreFields, tokensFromOpenAI, getByPath };")();

  // ---- Lens fixtures -----------------------------------------------------
  console.log(`capturing from ${MODEL}`);
  const lensReceipt = makeReceipt(0);
  const lensText = lensReceipt.text.replace(/##\/##\/##/, "##/##/##");   // keep as authored
  const receiptResp = await extract(lensText);
  console.log("\n  lens receipt:", receiptResp.choices[0].message.content.replace(/\s+/g, " ").slice(0, 80));

  const PROSE_PROMPT = "In three sentences, summarize the Apollo 11 mission: when it landed, who the crew were, and how long it lasted.";
  const proseResp = await call({ messages: [{ role: "user", content: PROSE_PROMPT }] });
  console.log("  lens prose  :", proseResp.choices[0].message.content.replace(/\s+/g, " ").slice(0, 80));

  // ---- calibration set: real scores, real labels --------------------------
  console.log(`\ncalibrating on ${N_CALIB} receipts`);
  const calibDocs = Array.from({ length: N_CALIB }, (_, i) => makeReceipt(i + 100));
  const results = await pool(calibDocs, async doc => {
    const resp = await extract(doc.text);
    const { fields, fullText, jsonStart, jsonEnd } = core.scoreFields(core.tokensFromOpenAI(resp));
    let data;
    try { data = JSON.parse(fullText.slice(jsonStart, jsonEnd)); } catch (e) { return null; }
    const rows = [];
    for (const f of Object.values(fields)) {
      const ok = isCorrect(f.path, core.getByPath(data, f.path), doc.truth);
      if (ok === null) continue;
      rows.push({ score: round(f.meanLogprob), min: round(f.minLogprob), correct: ok });
    }
    return { doc, resp, rows };
  });

  const good = results.filter(Boolean);
  const calib = good.flatMap(r => r.rows);
  const nWrong = calib.filter(r => !r.correct).length;
  console.log(`\n  ${calib.length} labelled fields, ${nWrong} incorrect (${(nWrong / calib.length * 100).toFixed(1)}%)`);

  // ---- batch fixture: separate receipts, so the demo batch is not the same
  // data the demo policy was fitted on --------------------------------------
  console.log(`\ncapturing ${N_BATCH} more receipts for the batch demo`);
  const batchDocs = Array.from({ length: N_BATCH }, (_, i) => makeReceipt(i + 500));
  const batchResp = await pool(batchDocs, async doc => {
    try { return { doc, resp: await extract(doc.text) }; } catch (e) { return null; }
  });
  const batch = batchResp.filter(Boolean).map(r =>
    JSON.stringify({ id: r.doc.id, response: slim(r.resp, false) }));
  console.log(`\n  ${batch.length} batch responses`);

  const capturedAt = new Date().toISOString().slice(0, 10);
  const body = `// GENERATED by scripts/capture-demo.js - do not edit by hand.
//
// Real ${MODEL} output. Every probability, extraction and label below came
// from the model; none of it was written by us. See docs/DEMO_DATA.md.
//
//   captured : ${capturedAt}
//   model    : ${MODEL}
//   receipts : temperature 0, response_format json_object, top_logprobs 2
//   prose    : default temperature (wording is genuinely open; temperature 0 hides that)

const DEMO_META = ${JSON.stringify({ model: MODEL, capturedAt, nCalib: calib.length, nBatch: batch.length })};

// The receipt below carries realistic damage: "##" marks characters that are
// not on the paper. Whatever the model returns for those is a guess - which is
// exactly the case per-field confidence exists for.
const DEMO_RECEIPT_TEXT = ${JSON.stringify(lensText)};
const DEMO_RESPONSE = ${JSON.stringify(slim(receiptResp, true))};

const DEMO_PROSE_PROMPT = ${JSON.stringify(PROSE_PROMPT)};
const DEMO_PROSE = ${JSON.stringify(slim(proseResp, true))};

// Calibration: ${calib.length} fields from ${good.length} receipts, scored by the model and
// labelled against ground truth we control (a destroyed field cannot be read,
// so any value for it is wrong). ${nWrong} of them are wrong.
const DEMO_CALIB_ROWS = ${JSON.stringify(calib.map(r => [r.score, r.correct ? 1 : 0]))};

// ${batch.length} of those receipts, whole, for the Workspace batch demo.
const DEMO_BATCH_JSONL = ${JSON.stringify(batch.join("\n"))};
`;
  fs.writeFileSync(OUT, body);
  console.log(`wrote src/fixtures.js (${(body.length / 1024).toFixed(1)} KB)`);
  console.log("next: npm run build && npm test");
})();
