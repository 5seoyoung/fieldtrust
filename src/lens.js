// Lens - inspect a single response.
//   structured mode: annotated JSON + routing decisions (needs a policy)
//   free-text mode : token heatmap + least certain passages (exploration only)

// ---------- structured: annotated JSON ----------
function renderHero() {
  const raw = state.lens.fullText;
  const js = raw.indexOf("{"), je = raw.lastIndexOf("}") + 1;
  $("hero").innerHTML = renderNode(JSON.parse(raw.slice(js, je)), "$", 0);
  document.querySelectorAll("#hero .val").forEach(el => bindPop(el, () => {
    const f = state.lens.fields[el.dataset.path];
    return f ? fieldPopHtml(f) : null;
  }));
}

function renderNode(v, path, ind) {
  const pad = "  ".repeat(ind), pad2 = "  ".repeat(ind + 1);
  if (Array.isArray(v)) {
    if (!v.length) return "[]";
    return "[\n" + v.map((x, i) => pad2 + renderNode(x, `${path}[${i}]`, ind + 1)).join(",\n") + "\n" + pad + "]";
  }
  if (v !== null && typeof v === "object") {
    const keys = Object.keys(v);
    if (!keys.length) return "{}";
    return "{\n" + keys.map(k => `${pad2}<span class="jk">"${esc(k)}"</span>: ` + renderNode(v[k], `${path}.${k}`, ind + 1)).join(",\n") + "\n" + pad + "}";
  }
  const lit = esc(JSON.stringify(v));
  const f = state.lens.fields[path];
  if (!f) return lit;
  return `<span class="val ${decide(f)}" data-path="${esc(path)}" tabindex="0">${lit}` +
    `<span class="bar" style="width:${Math.max(6, f.geoProb * 100)}%"></span></span>`;
}

function fieldPopHtml(f) {
  const rows = f.tokens.map(t => tokenRow(t.text, t.logprob, false)).join("");
  const mg = f.meanMargin != null ? f.meanMargin.toFixed(2) : "-";
  return `<div class="pth">${esc(f.path)}</div>${rows}` +
    `<div class="st">geo ${pct(f.geoProb)} · min ${pct(f.minProb)} · margin ${mg}</div>`;
}

// ---------- structured: routing table ----------
function renderTable() {
  const rows = Object.values(state.lens.fields)
    .sort((a, b) => a.meanLogprob - b.meanLogprob)
    .map(f => {
      const d = decide(f);
      const mg = f.meanMargin != null ? f.meanMargin.toFixed(2) : "-";
      return `<tr><td>${esc(f.path)}</td><td class="num">${pct(f.geoProb)}</td>` +
        `<td class="num">${pct(f.minProb)}</td><td class="num">${mg}</td>` +
        `<td><span class="pill ${d}">${d === "auto" ? "AUTO-ACCEPT" : "REVIEW"}</span></td></tr>`;
    }).join("");
  $("tableWrap").innerHTML = `<table><thead><tr><th>Field</th><th class="num">Conf (geo)</th>` +
    `<th class="num">Min tok</th><th class="num">Margin</th><th>Decision</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// Where the decisions on this screen come from - the policy lives in Workspace.
function renderPolicyNote() {
  const f = state.fit;
  $("policyNote").innerHTML = f && f.feasible
    ? `Routing with the policy fitted in <a href="#workspace">Workspace</a>: auto-accept at mean logprob &ge; <b>${f.threshold.toFixed(3)}</b>, ` +
      `for precision &ge; ${pct(f.targetPrecision, 0)} at ${pct(1 - f.delta, 0)} confidence.`
    : `No feasible policy yet - every field routes to review. Fit one in <a href="#workspace">Workspace</a>.`;
}

// ---------- free text: honesty banner ----------
// Wording is fixed by docs/PLAN_v2.md 2.2 and deliberately not marketing copy:
// it states the limit of the signal rather than hiding it.
const HONESTY_TEXT =
  "A low token probability does not mean “this is wrong” - it can mean “there were many ways to word this.” " +
  "The signal that correlates most strongly with factual errors comes from schema-constrained structured output.";

function renderHonesty() {
  const el = $("honesty");
  if (state.honestyDismissed) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = `<div class="htext">${HONESTY_TEXT}</div>` +
    `<div class="hact"><button class="linkbtn" id="honestyStructured">Use structured mode</button>` +
    `<button class="linkbtn" id="honestyDismiss">Got it</button></div>`;
  $("honestyDismiss").addEventListener("click", () => {
    state.honestyDismissed = true;
    el.hidden = true;
  });
  $("honestyStructured").addEventListener("click", () => setMode("structured"));
}

// ---------- free text: token heatmap ----------
function renderHeatmap() {
  const toks = state.lens.tokens;
  $("heatmap").innerHTML = toks.map((t, i) => {
    const p = Math.exp(t.logprob);
    // alpha carries the magnitude, band carries hue + underline style, so the
    // signal survives without colour vision (PLAN_v2 2.2).
    const a = Math.min(0.95, 0.1 + 0.85 * (1 - p)).toFixed(3);
    return `<span class="tkn ${band(p)}" data-i="${i}" style="--a:${a}" tabindex="0">${esc(t.text)}</span>`;
  }).join("");
  document.querySelectorAll("#heatmap .tkn").forEach(el =>
    bindPop(el, () => tokenPopHtml(toks[+el.dataset.i])));
}

function tokenPopHtml(t) {
  const alts = (t.alternatives || []).slice(0, 4);
  const rows = tokenRow(t.text, t.logprob, true) +
    alts.map(a => tokenRow(a.text, a.logprob, false)).join("");
  const note = alts.length
    ? "chosen token, then what else the model considered here"
    : "no top_logprobs in this response - request top_logprobs: 2 to see alternatives";
  return `<div class="pth">${esc(JSON.stringify(t.text))}</div>${rows}<div class="st">${note}</div>`;
}

// ---------- free text: least certain passages ----------
function renderSpans() {
  const sents = scoreSentences(state.lens.tokens);
  const ranked = sents.slice().sort((a, b) => a.meanLogprob - b.meanLogprob).slice(0, 3);
  if (!ranked.length) { $("spansWrap").innerHTML = `<div class="empty">No text to rank.</div>`; return; }
  $("spansWrap").innerHTML = ranked.map((s, i) => {
    const p = Math.exp(s.meanLogprob);
    return `<div class="span ${band(p)}">` +
      `<div class="spanhd"><span class="rank">#${i + 1}</span>` +
      `<span class="spanstat">geo ${pct(s.geoProb)} · min tok ${pct(Math.exp(s.minLogprob))} · ${s.nTokens} tokens</span></div>` +
      `<div class="spantext">${esc(s.text.trim())}</div></div>`;
  }).join("");
}

// ---------- mode ----------
function setMode(mode) {
  document.querySelectorAll("#modeSeg .segbtn").forEach(b => {
    const on = b.dataset.mode === mode;
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", String(on));
  });
  state.modeChoice = mode;
  if (state.lens) analyzeLens();
}

function renderLens() {
  const structured = state.lens.mode === "structured";
  $("structuredResults").hidden = !structured;
  $("freetextResults").hidden = structured;
  if (structured) {
    renderPolicyNote();
    renderHero();
    renderTable();
  } else {
    renderHonesty();
    renderHeatmap();
    renderSpans();
  }
}

function analyzeLens() {
  $("respErr").style.display = "none";
  hidePop();
  try {
    const tokens = tokensFromOpenAI(JSON.parse($("respIn").value));
    const choice = state.modeChoice || "auto";
    const detected = detectMode(tokens);
    const mode = choice === "auto" ? detected : choice;

    let fields = {}, fullText = tokens.map(t => t.text).join("");
    if (mode === "structured") {
      const res = scoreFields(tokens);
      fields = res.fields;
      fullText = res.fullText;
      if (!Object.keys(fields).length) throw new Error("no JSON fields found in this response");
    }
    state.lens = { mode, tokens, fields, fullText };
    $("modeNote").textContent = choice === "auto"
      ? `auto-detected: ${detected === "structured" ? "structured JSON" : "free text"}`
      : `forced: ${mode === "structured" ? "structured JSON" : "free text"}`;
    renderLens();
  } catch (e) {
    state.lens = null;
    $("respErr").textContent = "Could not analyze: " + e.message;
    $("respErr").style.display = "block";
  }
}
