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
  const corrections = r.items.filter(it => !it.isAudit).length;
  const share = s.nFields ? corrections / s.nFields : 0;

  // The audit: fields pulled from the auto-accept side by the uniform sample.
  // This is the only unbiased read of whether the guarantee actually held.
  const audit = auditPrecision(r.items, r.decisions);
  const target = state.fit && state.fit.feasible ? state.fit.targetPrecision : null;
  const held = target == null || isNaN(audit.precision) || audit.precision >= target;

  const guarantee = state.fit && state.fit.feasible
    ? `The other ${nfmt(s.nFields - corrections)} auto-accepted with precision guaranteed at &ge; ${pct(target, 0)}.`
    : `No feasible policy is fitted, so nothing auto-accepted.`;

  // Only the uniform calibration sample can be fed back (see refitFromReview).
  const nCalib = calibRows(r.items, r.decisions).length;
  const enough = nCalib >= MIN_CALIB_ROWS;

  const auditLine = audit.n
    ? `<div class="audit ${held ? "ok" : "bad"}">` +
      `<b>Audit:</b> of ${nfmt(audit.n)} auto-accepts spot-checked at random, ${nfmt(audit.correct)} were correct ` +
      `(${pct(audit.precision)}). ${held
        ? `That is at or above your ${pct(target, 0)} target - the guarantee is holding.`
        : `That is <b>below</b> your ${pct(target, 0)} target. The guarantee may have expired on this data; refit before trusting auto-accept.`}</div>`
    : `<div class="audit"><b>Audit:</b> no auto-accepts landed in the random sample on this batch - review a larger one to check the guarantee in production.</div>`;

  $("reviewBody").innerHTML = `
    <div class="rvdone">
      <div class="rvdonehd">Queue cleared</div>
      <p>You corrected the <b>${nfmt(corrections)}</b> below-threshold fields of ${nfmt(s.nFields)} (${pct(share)}). ${guarantee}</p>
      ${auditLine}
      <p class="rvdonesub">${nfmt(r.items.length - edits)} approved · ${nfmt(edits)} corrected.</p>
      <div class="rvdoneact">
        <button class="btn" id="rvRefit"${enough ? "" : " disabled"}>Refit from the audit sample</button>
        <button class="btn ghost" id="rvBack">Back to queue</button>
      </div>
      ${enough ? "" : `<p class="rvdonesub" id="rvRefitWhy">Refitting uses the uniform audit sample, not the correction queue (those labels are all below threshold and would bias the fit). This batch produced ${nfmt(nCalib)} audit labels; ${MIN_CALIB_ROWS} are needed. Review more batches to accumulate them.</p>`}
    </div>`;
  if (enough) $("rvRefit").addEventListener("click", refitFromReview);
  // reopening lets you walk back through decisions after clearing the queue
  $("rvBack").addEventListener("click", () => {
    state.review.reopened = true;
    state.review.idx = 0;
    renderReview();
  });
}

// ---------- the flywheel (PLAN_v2 1.1, corrected in D-007) ----------
// Review output is calibration input, but ONLY the uniform audit sample.
// The correction queue is every below-threshold field, i.e. a censored sample;
// pooling it froze the policy on real data (six batches moved the threshold
// zero). The audit sample is drawn uniformly across all fields regardless of
// the decision, so it is i.i.d. and plain Wilson stays valid when it is pooled
// with the existing calibration set.
function refitFromReview() {
  const rows = [];
  for (let i = 0; i < state.calib.scores.length; i++) {
    rows.push(`calib-${i},$,${state.calib.scores[i].toFixed(6)},${state.calib.correct[i] ? 1 : 0}`);
  }
  const fresh = calibRows(state.review.items, state.review.decisions);
  for (const row of fresh) {
    rows.push(`audit,$,${row.score.toFixed(6)},${row.correct ? 1 : 0}`);
  }
  $("csvIn").value = "doc_id,field_path,score,correct\n" + rows.join("\n") + "\n";
  $("csvIn").style.display = "block";
  $("tabCsv").classList.add("on");
  $("tabSynth").classList.remove("on");
  refit();
  $("csvErr").style.display = "none";
  $("calibProv").innerHTML = `<b>${nfmt(state.calib.scores.length)}</b> existing labels plus ` +
    `<b>${nfmt(fresh.length)}</b> from this batch's uniform audit sample. The audit is drawn ` +
    `across all fields regardless of the decision, so it stays an unbiased i.i.d. sample - ` +
    `the correction queue is not fed back, because it only ever holds below-threshold fields.`;
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
