// Routing, event wiring, boot. Runs last: every function it calls is already
// defined by the earlier script blocks.

const VIEWS = ["lens", "workspace", "about"];

function currentView() {
  const v = (location.hash || "").replace(/^#/, "");
  return VIEWS.includes(v) ? v : "lens";
}

function route() {
  const view = currentView();
  VIEWS.forEach(v => { $("view-" + v).classList.toggle("on", v === view); });
  document.querySelectorAll("#nav a").forEach(a => {
    const on = a.dataset.view === view;
    a.classList.toggle("on", on);
    if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
  hidePop();
  document.title = view === "lens"
    ? "FieldTrust - see where your LLM output can be trusted"
    : `FieldTrust - ${view[0].toUpperCase() + view.slice(1)}`;
}

// Two-tab helper: clicking one turns the other off.
function tabPair(a, b, onA, onB) {
  $(a).addEventListener("click", () => { $(a).classList.add("on"); $(b).classList.remove("on"); onA(); });
  $(b).addEventListener("click", () => { $(b).classList.add("on"); $(a).classList.remove("on"); onB(); });
}

// ---------- Lens wiring ----------
function tabsThree(ids, onEach) {
  ids.forEach(id => $(id).addEventListener("click", () => {
    ids.forEach(o => $(o).classList.toggle("on", o === id));
    onEach(id);
  }));
}

tabsThree(["tabSample", "tabProse", "tabPaste"], id => {
  if (id === "tabSample") { $("respIn").value = JSON.stringify(DEMO_RESPONSE, null, 1); analyzeLens(); }
  else if (id === "tabProse") { $("respIn").value = JSON.stringify(DEMO_PROSE, null, 1); analyzeLens(); }
  else {
    $("respIn").value = "";
    $("respIn").placeholder = "Paste the full chat.completions response JSON here (with logprobs)...";
    $("respIn").focus();
  }
});

document.querySelectorAll("#modeSeg .segbtn").forEach(b =>
  b.addEventListener("click", () => setMode(b.dataset.mode)));
$("analyze").addEventListener("click", analyzeLens);

// ---------- Workspace wiring ----------
tabPair("tabBatchDemo", "tabBatchPaste",
  () => { $("batchInputs").hidden = true; },
  () => { $("batchInputs").hidden = false; $("batchIn").focus(); });

$("batchFile").addEventListener("change", e => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => { $("batchIn").value = String(reader.result); loadBatch(); };
  reader.readAsText(file);
});
$("loadBatch").addEventListener("click", loadBatch);
$("expJsonl").addEventListener("click", exportJsonl);
$("expLabels").addEventListener("click", exportLabels);
$("expPolicy").addEventListener("click", exportPolicy);
$("exportMeta").addEventListener("change", renderExport);
document.addEventListener("keydown", reviewKeydown);

tabPair("tabSynth", "tabCsv",
  () => { $("csvIn").style.display = "none"; refit(); },
  () => { $("csvIn").style.display = "block"; $("csvIn").focus(); });

$("fit").addEventListener("click", refit);
$("target").addEventListener("input", () => {
  $("targetOut").textContent = Math.round($("target").value * 100) + "%";
  refit();
});
$("delta").addEventListener("change", refit);

// ---------- global ----------
window.addEventListener("hashchange", route);
document.addEventListener("click", hidePop);
$("yr").textContent = new Date().getFullYear();

// ---------- boot ----------
state.calib = demoCalib();
state.modeChoice = "auto";
route();
refit();                                            // fit the demo policy first
$("respIn").value = JSON.stringify(DEMO_RESPONSE, null, 1);
analyzeLens();                                      // ...so Lens can route with it
