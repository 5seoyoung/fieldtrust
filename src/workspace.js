// Workspace - batch operations and the review policy.
//   calibrate: fit a guaranteed threshold (moved here from Lens)
//   dashboard: how that policy plays out across a whole batch

// ---------- policy ----------
function renderThreshold() {
  const r = state.fit, warn = $("warn");
  if (!r.feasible) {
    warn.style.display = "block";
    warn.textContent = "Target not achievable with this calibration set at the chosen confidence - lower the target precision or add labeled data. All fields are routed to review.";
  } else warn.style.display = "none";
  const cells = [
    [r.feasible ? r.threshold.toFixed(3) : "-", "threshold (mean logprob)"],
    [r.feasible ? pct(r.autoAcceptRate) : "0%", "auto-accept rate (calib)"],
    [r.feasible ? pct(r.empiricalPrecision) : "-", "empirical precision"],
    [r.feasible ? pct(r.precisionLowerBound) : "-", "precision lower bound"],
  ];
  $("stats").innerHTML = cells.map(([b, s]) => `<div class="stat"><b>${b}</b><span>${s}</span></div>`).join("");
  const ar = r.feasible ? r.autoAcceptRate : 0;
  $("stripFill").style.width = pct(ar);
  $("stripLblA").textContent = r.feasible ? pct(ar) : "0%";
  $("stripLblR").textContent = pct(1 - ar);
  renderChart();
}

function renderChart() {
  const W = 560, H = 200, L = 42, B = 26, T = 10, R = 12;
  const c = state.fit.curve;
  const x = v => L + v * (W - L - R), y = v => T + (1 - (v - 0.6) / 0.4) * (H - T - B);
  const cl = v => Math.max(0.6, Math.min(1, v));
  const path = k => c.map((p, i) => `${i ? "L" : "M"}${x(p.coverage).toFixed(1)},${y(cl(p[k])).toFixed(1)}`).join(" ");
  const tgt = y(cl(state.fit.targetPrecision));
  let marker = "";
  if (state.fit.feasible) {
    const mx = x(state.fit.autoAcceptRate);
    marker = `<line x1="${mx}" y1="${T}" x2="${mx}" y2="${H - B}" stroke="#14201D" stroke-width="1.5"/>` +
      `<circle cx="${mx}" cy="${y(cl(state.fit.precisionLowerBound))}" r="4" fill="#0B7A66"/>`;
  }
  $("chart").innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Risk-coverage curve">
    <line x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}" stroke="#D9E2DF"/>
    <line x1="${L}" y1="${T}" x2="${L}" y2="${H - B}" stroke="#D9E2DF"/>
    ${[0.6, 0.7, 0.8, 0.9, 1].map(v => `<text x="${L - 6}" y="${y(v) + 3}" text-anchor="end">${(v * 100).toFixed(0)}</text><line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#EEF3F1"/>`).join("")}
    ${[0, 0.25, 0.5, 0.75, 1].map(v => `<text x="${x(v)}" y="${H - B + 14}" text-anchor="middle">${(v * 100).toFixed(0)}%</text>`).join("")}
    <line x1="${L}" x2="${W - R}" y1="${tgt}" y2="${tgt}" stroke="#B4790F" stroke-dasharray="5 4"/>
    <path d="${path('precision')}" fill="none" stroke="#5F6F6A" stroke-width="1.4"/>
    <path d="${path('lcb')}" fill="none" stroke="#0B7A66" stroke-width="2"/>
    ${marker}
    <text x="${W - R}" y="${tgt - 5}" text-anchor="end" fill="#B4790F">target</text>
    <text x="${L + 6}" y="${T + 10}">precision (grey) · Wilson LCB (teal) vs coverage</text>
  </svg>`;
}

function refit() {
  $("csvErr").style.display = "none";
  let data = state.calib;
  if ($("tabCsv").classList.contains("on")) {
    // accepts the 2-column form and the 4-column form review exports
    const parsed = parseLabelCsv($("csvIn").value);
    if (parsed.scores.length < MIN_CALIB_ROWS) {
      $("csvErr").textContent = `need at least ${MIN_CALIB_ROWS} usable rows, got ${parsed.scores.length}` +
        (parsed.skipped ? ` (${parsed.skipped} row(s) unparsable)` : "");
      $("csvErr").style.display = "block";
      return;
    }
    data = parsed;
  }
  state.fit = fitThreshold(data.scores, data.correct,
    parseFloat($("target").value), parseFloat($("delta").value));
  state.fittedAt = new Date().toISOString();
  renderThreshold();
  renderBatch();                       // policy moved -> batch decisions move
  if (state.batch) startReview(true);  // ...the queue is re-cut from the policy
  if (state.lens) renderLens();        // ...and so do the Lens decisions
  renderExport();
}

// ---------- batch ----------
async function loadBatch() {
  $("batchErr").style.display = "none";
  const text = $("tabBatchDemo").classList.contains("on") ? DEMO_BATCH_JSONL : $("batchIn").value;
  if (!text.trim()) {
    $("batchErr").textContent = "Paste JSONL or choose a file first.";
    $("batchErr").style.display = "block";
    return;
  }
  const { docs, errors } = parseBatch(text);
  if (!docs.length) {
    state.batch = null;
    state.review = null;
    $("batchErr").textContent = errors.length
      ? `No usable responses. First error (line ${errors[0].line}): ${errors[0].message}`
      : "No usable responses found.";
    $("batchErr").style.display = "block";
    renderBatch();
    renderReview();
    renderExport();
    return;
  }
  state.batch = { docs, errors, hash: hashText(text) };
  renderBatch();
  startReview(false);
  renderExport();
  await offerResume(state.batch.hash);
}

// Same file back again -> offer to pick up where the review left off (D-004).
async function offerResume(hash) {
  const bar = $("resumeBar");
  bar.hidden = true;
  const session = await loadSession(hash);
  const n = session && session.corrections ? Object.keys(session.corrections).length : 0;
  if (!n) return;
  const when = new Date(session.updatedAt).toLocaleString();
  bar.hidden = false;
  bar.innerHTML = `<span>You reviewed <b>${nfmt(n)}</b> field(s) in this batch on ${esc(when)}.</span>` +
    `<span class="resumeact"><button class="linkbtn" id="resumeYes">Resume</button>` +
    `<button class="linkbtn" id="resumeNo">Start over</button></span>`;
  $("resumeYes").addEventListener("click", () => {
    const r = state.review;
    for (const it of r.items) if (session.corrections[it.key]) r.decisions[it.key] = session.corrections[it.key];
    r.idx = nextUndecided(-1);
    bar.hidden = true;
    renderReview();
    renderBatch();
    renderExport();
  });
  $("resumeNo").addEventListener("click", async () => {
    bar.hidden = true;
    await deleteSession(hash);
    startReview(false);
  });
}

function renderBatch() {
  const has = !!(state.batch && state.batch.docs.length);
  $("batchEmpty").hidden = has;
  $("histCard").hidden = !has;
  $("pathCard").hidden = !has;
  $("batchStats").innerHTML = "";
  $("batchNote").textContent = "";
  if (!has) return;

  const { docs, errors } = state.batch;
  const thr = state.fit && state.fit.feasible ? state.fit.threshold : NaN;
  const s = batchSummary(docs, thr);

  $("batchNote").textContent = `${nfmt(docs.length)} responses parsed` +
    (errors.length ? ` · ${nfmt(errors.length)} line(s) skipped (first: line ${errors[0].line})` : "");

  const reviewed = state.review ? Object.keys(state.review.decisions).length : 0;
  const cells = [
    [nfmt(s.nDocs), "responses"],
    [nfmt(s.nFields), "fields"],
    [Number.isFinite(thr) ? pct(s.autoAcceptRate) : "0%", "auto-accept on this batch"],
    [`${nfmt(reviewed)} / ${nfmt(s.nReview)}`, "reviewed"],
  ];
  $("batchStats").innerHTML = cells.map(([b, t]) => `<div class="stat"><b>${b}</b><span>${t}</span></div>`).join("");
  renderHist(docs, thr);
  renderPathTable(docs, thr);
}

// ---------- export (PLAN_v2 3.4) ----------
function download(filename, text, mime) {
  const blob = new Blob([text], { type: (mime || "text/plain") + ";charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function renderExport() {
  const has = !!(state.batch && state.batch.docs.length);
  $("exportCard").hidden = !has;
  if (!has) return;
  const reviewed = state.review ? Object.keys(state.review.decisions).length : 0;
  $("exportNote").textContent = reviewed
    ? `${nfmt(reviewed)} decision(s) will be applied.`
    : "No review decisions yet - the corrected file will match the input, and the label CSV will be empty.";
}

function exportJsonl() {
  const thr = state.fit && state.fit.feasible ? state.fit.threshold : NaN;
  download("fieldtrust-corrected.jsonl",
    toCorrectedJsonl(state.batch.docs, state.review ? state.review.decisions : {},
      { meta: $("exportMeta").checked, threshold: thr }),
    "application/x-ndjson");
}

function exportLabels() {
  download("fieldtrust-labels.csv",
    toLabelCsv(state.review ? state.review.items : [], state.review ? state.review.decisions : {}),
    "text/csv");
}

function exportPolicy() {
  download("fieldtrust-policy.json", toPolicyJson(state.fit, state.fittedAt), "application/json");
}

function renderHist(docs, thr) {
  const fields = [];
  for (const d of docs) for (const f of Object.values(d.fields)) fields.push(f);
  const buckets = confidenceBuckets(fields, thr);
  const W = 560, H = 190, L = 34, B = 34, T = 8, R = 10;
  const maxC = buckets.reduce((m, b) => Math.max(m, b.count), 1);
  const slot = (W - L - R) / buckets.length;
  const bw = slot - 8;
  const h = c => (c / maxC) * (H - T - B);

  // stacked: review at the bottom, auto on top. A bucket the threshold runs
  // through is drawn as both, which is what is actually true of it.
  const bars = buckets.map((b, i) => {
    const x = L + i * slot + 4;
    const hr = h(b.review), ha = h(b.auto);
    return `<rect x="${x.toFixed(1)}" y="${(H - B - hr).toFixed(1)}" width="${bw.toFixed(1)}" height="${hr.toFixed(1)}" fill="#B23A2B" opacity=".75"/>` +
      `<rect x="${x.toFixed(1)}" y="${(H - B - hr - ha).toFixed(1)}" width="${bw.toFixed(1)}" height="${ha.toFixed(1)}" fill="#0B7A66" opacity=".85"/>` +
      (b.count ? `<text x="${(x + bw / 2).toFixed(1)}" y="${(H - B - hr - ha - 4).toFixed(1)}" text-anchor="middle">${b.count}</text>` : "");
  }).join("");

  const label = b => b.hi === 1 ? "100%" : (b.hi * 100).toFixed(b.hi >= 0.99 ? 1 : 0) + "%";
  const ticks = buckets.map((b, i) =>
    `<text x="${(L + i * slot + slot / 2).toFixed(1)}" y="${H - B + 13}" text-anchor="middle">${
      b.lo === 0 ? "<" + label(b) : label(b)}</text>`).join("");

  $("hist").innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Confidence distribution across the batch">
    <line x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}" stroke="#D9E2DF"/>
    ${bars}${ticks}
    <text x="${L}" y="${H - 4}" text-anchor="start">field confidence (geometric mean) ->  right = the model was sure</text>
    <rect x="${L}" y="${T}" width="8" height="8" fill="#0B7A66" opacity=".85"/>
    <text x="${L + 12}" y="${T + 8}" text-anchor="start" fill="#0B7A66">auto-accept</text>
    <rect x="${L + 78}" y="${T}" width="8" height="8" fill="#B23A2B" opacity=".75"/>
    <text x="${L + 90}" y="${T + 8}" text-anchor="start" fill="#B23A2B">review</text>
  </svg>`;
}

function renderPathTable(docs, thr) {
  const rows = aggregateByPath(docs, thr).map(r => {
    const risky = r.belowRate >= 0.5;
    return `<tr><td>${esc(r.path)}</td><td class="num">${nfmt(r.count)}</td>` +
      `<td class="num">${pct(r.meanGeoProb)}</td><td class="num">${pct(r.minGeoProb)}</td>` +
      `<td class="num"><span class="pill ${risky ? "review" : "auto"}">${pct(r.belowRate, 0)}</span></td></tr>`;
  }).join("");
  $("pathWrap").innerHTML = `<table><thead><tr><th>Field path</th><th class="num">Count</th>` +
    `<th class="num">Mean conf</th><th class="num">Worst</th><th class="num">Below thr.</th>` +
    `</tr></thead><tbody>${rows}</tbody></table>`;
}
