// Shared app state, formatting helpers, and the token popover used by both
// the structured field view and the free-text heatmap.

const state = {
  calib: null,   // {scores, correct} - calibration set
  fit: null,     // fitThreshold() result - the active review policy
  lens: null,    // {mode, tokens, fields, fullText} - single response in Lens
  batch: null,   // {docs, errors} - loaded JSONL batch in Workspace
  honestyDismissed: false,
};

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const pct = (x, d = 1) => (x * 100).toFixed(d) + "%";
const nfmt = n => n.toLocaleString("en-US");

// A field is auto-accepted only when a feasible policy says so. With no
// policy fitted, everything routes to review - the safe default.
function decide(f) {
  return state.fit && state.fit.feasible && f.meanLogprob >= state.fit.threshold ? "auto" : "review";
}

// Probability -> confidence band. Shared by the heatmap and the ramp legend so
// the colours in the legend always mean what the tokens mean.
function band(p) {
  return p >= 0.85 ? "hi" : p >= 0.5 ? "mid" : "lo";
}

// ---------- popover ----------
function hidePop() { $("pop").style.display = "none"; }

function showPop(el, html) {
  const pop = $("pop");
  pop.innerHTML = html;
  pop.style.display = "block";
  const r = el.getBoundingClientRect();
  pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 320)) + "px";
  pop.style.top = (r.bottom + 8) + "px";
}

// buildHtml is called lazily on hover/focus so popovers cost nothing to bind.
function bindPop(el, buildHtml) {
  const show = () => { const h = buildHtml(); if (h) showPop(el, h); };
  el.addEventListener("mouseenter", show);
  el.addEventListener("mouseleave", hidePop);
  el.addEventListener("focus", show);
  el.addEventListener("blur", hidePop);
  el.addEventListener("click", e => { e.stopPropagation(); show(); });
}

function tokenRow(text, logprob, isChosen) {
  const p = Math.exp(logprob);
  return `<div class="trow${isChosen ? " chosen" : ""}">` +
    `<span class="tk">${esc(JSON.stringify(text))}</span>` +
    `<span class="tb" style="width:${Math.max(2, p * 90)}px"></span>` +
    `<span class="tp">${(p * 100).toFixed(1)}%</span></div>`;
}
