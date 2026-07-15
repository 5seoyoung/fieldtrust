// Review queue (PLAN_v2 3.3) - one below-threshold field at a time, riskiest
// first, driven from the keyboard. Reviewing is also how labels get made:
// approve = the value was right, edit = it was wrong. See toLabelCsv.

function startReview(preserveDecisions) {
  const thr = state.fit && state.fit.feasible ? state.fit.threshold : NaN;
  const prev = preserveDecisions && state.review ? state.review.decisions : {};
  const items = reviewQueue(state.batch.docs, thr);
  const live = {};
  // a refit changes the queue; keep decisions for fields that are still in it
  for (const it of items) if (prev[it.key]) live[it.key] = prev[it.key];
  state.review = {
    items, decisions: live, history: [], idx: 0, editing: false,
    batchHash: state.batch.hash,
  };
  state.review.idx = nextUndecided(-1);
  renderReview();
}

function nextUndecided(from) {
  const { items, decisions } = state.review;
  for (let i = from + 1; i < items.length; i++) if (!decisions[items[i].key]) return i;
  for (let i = 0; i <= Math.min(from, items.length - 1); i++) if (!decisions[items[i].key]) return i;
  return Math.max(0, Math.min(from, items.length - 1));
}

function reviewDone() {
  const r = state.review;
  return r && r.items.length > 0 && Object.keys(r.decisions).length >= r.items.length;
}

// ---------- actions ----------
function decideCurrent(action, value) {
  const r = state.review;
  const it = r.items[r.idx];
  if (!it) return;
  r.history.push({ key: it.key, idx: r.idx, prev: r.decisions[it.key] || null });
  r.decisions[it.key] = value === undefined ? { action } : { action, value };
  r.editing = false;
  r.idx = nextUndecided(r.idx);
  persistReview();
  renderReview();
  renderBatch();    // reviewed counts feed the dashboard...
  renderExport();   // ...and what the export will contain
}

function undoReview() {
  const r = state.review;
  const last = r.history.pop();
  if (!last) return;
  if (last.prev) r.decisions[last.key] = last.prev; else delete r.decisions[last.key];
  r.idx = last.idx;
  r.editing = false;
  persistReview();
  renderReview();
  renderBatch();
  renderExport();
}

function moveReview(delta) {
  const r = state.review;
  if (!r.items.length) return;
  r.idx = Math.max(0, Math.min(r.items.length - 1, r.idx + delta));
  r.editing = false;
  renderReview();
}

function beginEdit() {
  if (!state.review.items.length) return;
  state.review.editing = true;
  renderReview();
  const input = $("rvEdit");
  if (input) { input.focus(); input.select(); }
}

// Strings are edited bare (nobody wants to type quotes); other kinds go
// through JSON so numbers stay numbers and null stays null.
function commitEdit() {
  const r = state.review, it = r.items[r.idx], input = $("rvEdit");
  if (!input) return;
  const raw = input.value;
  let value;
  if (it.kind === "string") value = raw;
  else {
    try { value = JSON.parse(raw); }
    catch (e) {
      $("rvEditErr").textContent = "Not valid JSON for a " + it.kind + " field";
      $("rvEditErr").style.display = "block";
      return;
    }
  }
  decideCurrent("edit", value);
}

// ---------- persistence ----------
function persistReview() {
  const r = state.review;
  if (!r || !r.batchHash) return;
  saveSession({
    batchHash: r.batchHash,
    progress: { idx: r.idx, total: r.items.length },
    corrections: r.decisions,
    updatedAt: new Date().toISOString(),
  });
}

// ---------- render ----------
function renderReview() {
  const card = $("reviewCard");
  if (!state.batch || !state.review) { card.hidden = true; return; }
  card.hidden = false;
  const r = state.review;

  if (!r.items.length) {
    $("reviewBody").innerHTML = `<div class="empty">Nothing to review - every field in this batch cleared the threshold.</div>`;
    return;
  }
  if (reviewDone() && !r.reopened) { renderReviewDone(); return; }

  const it = r.items[r.idx];
  const done = Object.keys(r.decisions).length, total = r.items.length;
  const decided = r.decisions[it.key];
  const val = it.kind === "string" ? String(it.value) : JSON.stringify(it.value);

  $("reviewBody").innerHTML = `
    <div class="rvhead">
      <span class="rvprog"><b>${nfmt(done)}</b> / ${nfmt(total)} reviewed</span>
      <span class="rvpos">${nfmt(r.idx + 1)} of ${nfmt(total)} in queue${
        reviewDone() ? ` · <button class="linkbtn" id="rvSummary">summary</button>` : ""}</span>
    </div>
    <div class="rvbar"><div class="rvfill" style="width:${(done / total * 100).toFixed(1)}%"></div></div>
    <div class="rvitem${decided ? " decided" : ""}">
      <div class="rvtop"><span class="rvpath">${esc(it.path)}</span><span class="rvdoc">${esc(it.docId)}</span></div>
      ${r.editing
        ? `<input class="rvedit" id="rvEdit" value="${esc(val)}" aria-label="Corrected value" spellcheck="false">
           <div class="err" id="rvEditErr"></div>
           <div class="rvhint">Enter to save · Esc to cancel</div>`
        : `<div class="rvvalue" id="rvValue" tabindex="0">${esc(val)}</div>`}
      <div class="rvconf">geo ${pct(it.geoProb)} · min tok ${pct(it.minProb)} · ${it.tokens.length} tokens</div>
      <div class="rvtokens">${it.tokens.map(t => tokenRow(t.text, t.logprob, false)).join("")}</div>
      ${it.context ? `<div class="rvctx"><span class="rvctxlbl">source</span>${esc(it.context)}</div>` : ""}
      ${decided ? `<div class="rvdecided">already ${decided.action === "approve" ? "approved" : "corrected"}${
        decided.action === "edit" ? ` to <b>${esc(JSON.stringify(decided.value))}</b>` : ""} - deciding again replaces it</div>` : ""}
    </div>
    <div class="rvkeys">
      <button class="rvbtn" id="rvApprove"><kbd>a</kbd> approve</button>
      <button class="rvbtn" id="rvEditBtn"><kbd>e</kbd> edit</button>
      <button class="rvbtn" id="rvPrev"><kbd>k</kbd> prev</button>
      <button class="rvbtn" id="rvNext"><kbd>j</kbd> next</button>
      <button class="rvbtn" id="rvUndo"${r.history.length ? "" : " disabled"}><kbd>u</kbd> undo</button>
    </div>`;

  if (r.editing) {
    $("rvEdit").addEventListener("keydown", e => {
      if (e.key === "Enter") { e.preventDefault(); commitEdit(); }
      if (e.key === "Escape") { e.preventDefault(); r.editing = false; renderReview(); }
    });
  } else {
    bindPop($("rvValue"), () => `<div class="pth">${esc(it.path)}</div>` +
      it.tokens.map(t => tokenRow(t.text, t.logprob, false)).join("") +
      `<div class="st">geo ${pct(it.geoProb)} · min ${pct(it.minProb)}</div>`);
  }
  $("rvApprove").addEventListener("click", () => decideCurrent("approve"));
  $("rvEditBtn").addEventListener("click", beginEdit);
  $("rvPrev").addEventListener("click", () => moveReview(-1));
  $("rvNext").addEventListener("click", () => moveReview(1));
  $("rvUndo").addEventListener("click", undoReview);
  if ($("rvSummary")) $("rvSummary").addEventListener("click", () => {
    r.reopened = false; renderReview();
  });
}

function renderReviewDone() {
  const r = state.review;
  const s = batchSummary(state.batch.docs, state.fit && state.fit.feasible ? state.fit.threshold : NaN);
  const edits = Object.values(r.decisions).filter(d => d.action === "edit").length;
  const share = s.nFields ? r.items.length / s.nFields : 0;
  const guarantee = state.fit && state.fit.feasible
    ? `The other ${nfmt(s.nFields - r.items.length)} auto-accepted with precision guaranteed at &ge; ${pct(state.fit.targetPrecision, 0)}.`
    : `No feasible policy is fitted, so nothing auto-accepted.`;

  $("reviewBody").innerHTML = `
    <div class="rvdone">
      <div class="rvdonehd">Queue cleared</div>
      <p>You reviewed <b>${nfmt(r.items.length)}</b> of ${nfmt(s.nFields)} fields (${pct(share)}). ${guarantee}</p>
      <p class="rvdonesub">${nfmt(r.items.length - edits)} approved · ${nfmt(edits)} corrected. That is a labeled set - feed it back and the next batch needs less review.</p>
      <div class="rvdoneact">
        <button class="btn" id="rvRefit">Refit threshold with these labels</button>
        <button class="btn ghost" id="rvBack">Back to queue</button>
      </div>
    </div>`;
  $("rvRefit").addEventListener("click", refitFromReview);
  // reopening lets you walk back through decisions after clearing the queue
  $("rvBack").addEventListener("click", () => {
    state.review.reopened = true;
    state.review.idx = 0;
    renderReview();
  });
}

// ---------- the flywheel (PLAN_v2 1.1) ----------
// Review output is calibration input. One click, no file round-trip.
function refitFromReview() {
  const csv = toLabelCsv(state.review.items, state.review.decisions);
  $("csvIn").value = csv;
  $("csvIn").style.display = "block";
  $("tabCsv").classList.add("on");
  $("tabSynth").classList.remove("on");
  refit();
  const body = $("reviewBody");
  if (body.scrollIntoView) body.scrollIntoView({ block: "nearest" });
}

// ---------- keyboard (PLAN_v2 3.3) ----------
function reviewKeydown(e) {
  if (!state.review || !state.review.items.length) return;
  if (currentView() !== "workspace") return;
  if (state.review.editing) return;            // the input owns the keyboard
  if (reviewDone()) return;
  const t = e.target;
  if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  const k = e.key.toLowerCase();
  const act = { a: () => decideCurrent("approve"), e: beginEdit, u: undoReview,
                j: () => moveReview(1), k: () => moveReview(-1) }[k];
  if (!act) return;
  e.preventDefault();
  act();
}
