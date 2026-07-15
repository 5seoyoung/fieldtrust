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
    try {
      const s = [], c = [];
      $("csvIn").value.trim().split(/\n+/).forEach(line => {
        const [a, b] = line.split(/[,\t]/);
        const sc = parseFloat(a), cc = parseInt(b);
        if (!isNaN(sc) && !isNaN(cc)) { s.push(sc); c.push(!!cc); }
      });
      if (s.length < 20) throw new Error("need at least 20 rows");
      data = { scores: s, correct: c };
    } catch (e) {
      $("csvErr").textContent = e.message;
      $("csvErr").style.display = "block";
      return;
    }
  }
  state.fit = fitThreshold(data.scores, data.correct,
    parseFloat($("target").value), parseFloat($("delta").value));
  renderThreshold();
  renderBatch();                       // policy moved -> batch decisions move
  if (state.lens) renderLens();        // ...and so do the Lens decisions
}

// ---------- batch ----------
function loadBatch() {
  $("batchErr").style.display = "none";
  const text = $("tabBatchDemo").classList.contains("on") ? demoBatch(120) : $("batchIn").value;
  if (!text.trim()) {
    $("batchErr").textContent = "Paste JSONL or choose a file first.";
    $("batchErr").style.display = "block";
    return;
  }
  const { docs, errors } = parseBatch(text);
  if (!docs.length) {
    state.batch = null;
    $("batchErr").textContent = errors.length
      ? `No usable responses. First error (line ${errors[0].line}): ${errors[0].message}`
      : "No usable responses found.";
    $("batchErr").style.display = "block";
    renderBatch();
    return;
  }
  state.batch = { docs, errors };
  renderBatch();
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

  const cells = [
    [nfmt(s.nDocs), "responses"],
    [nfmt(s.nFields), "fields"],
    [Number.isFinite(thr) ? pct(s.autoAcceptRate) : "0%", "auto-accept on this batch"],
    [nfmt(s.nReview), "fields to review"],
  ];
  $("batchStats").innerHTML = cells.map(([b, t]) => `<div class="stat"><b>${b}</b><span>${t}</span></div>`).join("");
  renderHist(docs, thr);
  renderPathTable(docs, thr);
}

function renderHist(docs, thr) {
  const values = [];
  for (const d of docs) for (const f of Object.values(d.fields)) values.push(f.meanLogprob);
  const bins = histogramBins(values, 28);
  const W = 560, H = 180, L = 34, B = 26, T = 8, R = 10;
  const maxC = bins.reduce((m, b) => Math.max(m, b.count), 1);
  const x0 = bins[0].x0, x1 = bins[bins.length - 1].x1;
  const x = v => L + ((v - x0) / (x1 - x0)) * (W - L - R);
  const y = c => T + (1 - c / maxC) * (H - T - B);
  const bw = Math.max(1, (W - L - R) / bins.length - 1.5);

  const bars = bins.map(b => {
    const auto = Number.isFinite(thr) && b.x0 >= thr;
    return `<rect x="${x(b.x0).toFixed(1)}" y="${y(b.count).toFixed(1)}" width="${bw.toFixed(1)}" ` +
      `height="${(H - B - y(b.count)).toFixed(1)}" fill="${auto ? "#0B7A66" : "#B23A2B"}" opacity="${auto ? 0.85 : 0.7}"/>`;
  }).join("");
  const line = Number.isFinite(thr) && thr >= x0 && thr <= x1
    ? `<line x1="${x(thr).toFixed(1)}" y1="${T}" x2="${x(thr).toFixed(1)}" y2="${H - B}" stroke="#14201D" stroke-width="1.5"/>` +
      `<text x="${x(thr).toFixed(1)}" y="${T + 9}" text-anchor="middle" fill="#14201D">threshold</text>` : "";

  $("hist").innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Confidence distribution across the batch">
    <line x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}" stroke="#D9E2DF"/>
    ${bars}${line}
    ${[x0, (x0 + x1) / 2, x1].map(v => `<text x="${x(v).toFixed(1)}" y="${H - B + 14}" text-anchor="middle">${v.toFixed(2)}</text>`).join("")}
    <text x="${L}" y="${H - 4}" text-anchor="start">mean logprob per field ->  higher = more confident</text>
    <text x="${L - 6}" y="${y(maxC) + 4}" text-anchor="end">${maxC}</text>
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
