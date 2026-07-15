// ---------- demo data ----------
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
function demoCalib(){const r=mulberry32(7),s=[],c=[];for(let i=0;i<500;i++){const sc=-3*r();s.push(sc);c.push(r()<1/(1+Math.exp(-(3*sc+5.5))))}return{scores:s,correct:c}}

function tok(t,lp,second){const o={token:t,logprob:lp};if(second!=null)o.top_logprobs=[{token:t,logprob:lp},{token:"·",logprob:second}];return o}
const DEMO_RESPONSE={choices:[{message:{content:""},logprobs:{content:[
 tok('{"',-0.0005),tok('vendor',-0.0008),tok('":',-0.0006),tok(' "',-0.001),
 tok('Star',-0.012,-5.4),tok('bucks',-0.018,-5.1),tok('",',-0.0009),
 tok(' "',-0.0007),tok('date',-0.0008),tok('":',-0.0006),tok(' "',-0.001),
 tok('202',-0.05,-3.6),tok('4',-0.09,-3.1),tok('-02-',-1.92,-2.05),tok('31',-2.31,-2.42),tok('",',-0.001),
 tok(' "',-0.0008),tok('total',-0.0009),tok('":',-0.0007),tok(' ',-0.001),
 tok('18',-0.22,-2.6),tok('.',-0.04,-3.9),tok('40',-0.31,-1.9),tok(',',-0.0009),
 tok(' "',-0.0008),tok('currency',-0.0009),tok('":',-0.0006),tok(' "',-0.001),
 tok('USD',-0.03,-4.2),tok('",',-0.0009),
 tok(' "',-0.0008),tok('items',-0.0009),tok('":',-0.0007),tok(' [',-0.001),
 tok('{"',-0.0008),tok('name',-0.0009),tok('":',-0.0006),tok(' "',-0.001),
 tok('Latte',-0.08,-3.2),tok('",',-0.001),tok(' "',-0.0008),tok('qty',-0.0009),tok('":',-0.0006),
 tok(' ',-0.001),tok('2',-0.14,-2.4),tok('},',-0.001),
 tok(' {"',-0.0008),tok('name',-0.0009),tok('":',-0.0006),tok(' "',-0.001),
 tok('Blue',-0.95,-1.35),tok('berry',-0.42,-1.7),tok(' Muffin',-0.66,-1.2),tok('",',-0.001),
 tok(' "',-0.0008),tok('qty',-0.0009),tok('":',-0.0006),tok(' ',-0.001),tok('1',-0.06,-3.5),
 tok('}]',-0.001),tok('}',-0.0006)
]}}]};

// ---------- state ----------
let calib=demoCalib();
let fitRes=null;
let fields={};

// ---------- helpers ----------
const $=id=>document.getElementById(id);
const esc=s=>s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
const pct=x=>(x*100).toFixed(1)+"%";

function decide(f){return fitRes&&fitRes.feasible&&f.meanLogprob>=fitRes.threshold?"auto":"review"}

// ---------- annotated JSON (signature) ----------
function renderHero(){
  // rebuild from the token concatenation captured in analyze()
  const raw=window.__fullText;
  const js=raw.indexOf("{"),je=raw.lastIndexOf("}")+1;
  const data=JSON.parse(raw.slice(js,je));
  $("hero").innerHTML=renderNode(data,"$",0);
  bindPopovers();
}
function renderNode(v,path,ind){
  const pad="  ".repeat(ind),pad2="  ".repeat(ind+1);
  if(Array.isArray(v)){
    if(!v.length)return"[]";
    return"[\n"+v.map((x,i)=>pad2+renderNode(x,`${path}[${i}]`,ind+1)).join(",\n")+"\n"+pad+"]";
  }
  if(v!==null&&typeof v==="object"){
    const keys=Object.keys(v);
    if(!keys.length)return"{}";
    return"{\n"+keys.map(k=>`${pad2}<span class="jk">"${esc(k)}"</span>: `+renderNode(v[k],`${path}.${k}`,ind+1)).join(",\n")+"\n"+pad+"}";
  }
  const lit=esc(JSON.stringify(v));
  const f=fields[path];
  if(!f)return lit;
  const d=decide(f);
  return`<span class="val ${d}" data-path="${esc(path)}" tabindex="0">${lit}<span class="bar" style="width:${Math.max(6,f.geoProb*100)}%"></span></span>`;
}

// ---------- popover ----------
function bindPopovers(){
  const pop=$("pop");
  document.querySelectorAll(".val").forEach(el=>{
    const show=()=>{
      const f=fields[el.dataset.path];if(!f)return;
      const rows=f.tokens.map(t=>{
        const p=Math.exp(t.logprob);
        return`<div class="trow"><span class="tk">${esc(JSON.stringify(t.text))}</span><span class="tb" style="width:${Math.max(2,p*90)}px"></span><span class="tp">${(p*100).toFixed(1)}%</span></div>`;
      }).join("");
      const mg=f.meanMargin!=null?f.meanMargin.toFixed(2):"–";
      pop.innerHTML=`<div class="pth">${esc(f.path)}</div>${rows}<div class="st">geo ${pct(f.geoProb)} · min ${pct(f.minProb)} · margin ${mg}</div>`;
      const r=el.getBoundingClientRect();
      pop.style.display="block";
      pop.style.left=Math.min(r.left,window.innerWidth-320)+"px";
      pop.style.top=(r.bottom+8)+"px";
    };
    const hide=()=>{pop.style.display="none"};
    el.addEventListener("mouseenter",show);el.addEventListener("mouseleave",hide);
    el.addEventListener("focus",show);el.addEventListener("blur",hide);
    el.addEventListener("click",e=>{e.stopPropagation();show()});
  });
  document.addEventListener("click",()=>{pop.style.display="none"});
}

// ---------- table ----------
function renderTable(){
  const rows=Object.values(fields).sort((a,b)=>a.meanLogprob-b.meanLogprob).map(f=>{
    const d=decide(f);
    const mg=f.meanMargin!=null?f.meanMargin.toFixed(2):"–";
    return`<tr><td>${esc(f.path)}</td><td class="num">${pct(f.geoProb)}</td><td class="num">${pct(f.minProb)}</td><td class="num">${mg}</td><td><span class="pill ${d}">${d==="auto"?"AUTO-ACCEPT":"REVIEW"}</span></td></tr>`;
  }).join("");
  $("tableWrap").innerHTML=`<table><thead><tr><th>Field</th><th class="num">Conf (geo)</th><th class="num">Min tok</th><th class="num">Margin</th><th>Decision</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// ---------- threshold panel ----------
function renderThreshold(){
  const r=fitRes;
  const warn=$("warn");
  if(!r.feasible){
    warn.style.display="block";
    warn.textContent="Target not achievable with this calibration set at the chosen confidence - lower the target precision or add labeled data. All fields are routed to review.";
  }else warn.style.display="none";
  const cells=[
    [r.feasible?r.threshold.toFixed(3):"-","threshold (mean logprob)"],
    [r.feasible?pct(r.autoAcceptRate):"0%","auto-accept rate"],
    [r.feasible?pct(r.empiricalPrecision):"-","empirical precision"],
    [r.feasible?pct(r.precisionLowerBound):"-","precision lower bound"],
  ];
  $("stats").innerHTML=cells.map(([b,s])=>`<div class="stat"><b>${b}</b><span>${s}</span></div>`).join("");
  const ar=r.feasible?r.autoAcceptRate:0;
  $("stripFill").style.width=pct(ar);
  $("stripLblA").textContent=r.feasible?pct(ar):"0%";
  $("stripLblR").textContent=pct(1-ar);
  renderChart();
}
function renderChart(){
  const W=560,H=200,L=42,B=26,T=10,R=12;
  const c=fitRes.curve;
  const x=v=>L+v*(W-L-R), y=v=>T+(1-(v-0.6)/0.4)*(H-T-B); // y domain [0.6,1]
  const cl=v=>Math.max(0.6,Math.min(1,v));
  const path=k=>c.map((p,i)=>`${i?"L":"M"}${x(p.coverage).toFixed(1)},${y(cl(p[k])).toFixed(1)}`).join(" ");
  const tgt=y(cl(fitRes.targetPrecision));
  let marker="";
  if(fitRes.feasible){
    const mx=x(fitRes.autoAcceptRate);
    marker=`<line x1="${mx}" y1="${T}" x2="${mx}" y2="${H-B}" stroke="#14201D" stroke-width="1.5"/><circle cx="${mx}" cy="${y(cl(fitRes.precisionLowerBound))}" r="4" fill="#0B7A66"/>`;
  }
  $("chart").innerHTML=`<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Risk-coverage curve">
    <line x1="${L}" y1="${H-B}" x2="${W-R}" y2="${H-B}" stroke="#D9E2DF"/>
    <line x1="${L}" y1="${T}" x2="${L}" y2="${H-B}" stroke="#D9E2DF"/>
    ${[0.6,0.7,0.8,0.9,1].map(v=>`<text x="${L-6}" y="${y(v)+3}" text-anchor="end">${(v*100).toFixed(0)}</text><line x1="${L}" x2="${W-R}" y1="${y(v)}" y2="${y(v)}" stroke="#EEF3F1"/>`).join("")}
    ${[0,0.25,0.5,0.75,1].map(v=>`<text x="${x(v)}" y="${H-B+14}" text-anchor="middle">${(v*100).toFixed(0)}%</text>`).join("")}
    <line x1="${L}" x2="${W-R}" y1="${tgt}" y2="${tgt}" stroke="#B4790F" stroke-dasharray="5 4"/>
    <path d="${path('precision')}" fill="none" stroke="#5F6F6A" stroke-width="1.4"/>
    <path d="${path('lcb')}" fill="none" stroke="#0B7A66" stroke-width="2"/>
    ${marker}
    <text x="${W-R}" y="${tgt-5}" text-anchor="end" fill="#B4790F">target</text>
    <text x="${L+6}" y="${T+10}">precision (grey) · Wilson LCB (teal) vs coverage</text>
  </svg>`;
}

// ---------- actions ----------
function analyze(){
  $("respErr").style.display="none";
  try{
    const parsed=JSON.parse($("respIn").value);
    const toks=tokensFromOpenAI(parsed);
    const res=scoreFields(toks);
    fields=res.fields; window.__fullText=res.fullText;
    renderHero();renderTable();
  }catch(e){
    $("respErr").textContent="Could not parse: "+e.message;
    $("respErr").style.display="block";
  }
}
function refit(){
  $("csvErr").style.display="none";
  let data=calib;
  if($("tabCsv").classList.contains("on")){
    try{
      const s=[],c=[];
      $("csvIn").value.trim().split(/\n+/).forEach(line=>{
        const[a,b]=line.split(/[,\t]/);const sc=parseFloat(a),cc=parseInt(b);
        if(!isNaN(sc)&&!isNaN(cc)){s.push(sc);c.push(!!cc)}
      });
      if(s.length<20)throw new Error("need at least 20 rows");
      data={scores:s,correct:c};
    }catch(e){
      $("csvErr").textContent=e.message;$("csvErr").style.display="block";return;
    }
  }
  fitRes=fitThreshold(data.scores,data.correct,parseFloat($("target").value),parseFloat($("delta").value));
  renderThreshold();
  if(Object.keys(fields).length){renderHero();renderTable()}
}

// tabs
function tabPair(a,b,onA,onB){
  $(a).addEventListener("click",()=>{$(a).classList.add("on");$(b).classList.remove("on");onA()});
  $(b).addEventListener("click",()=>{$(b).classList.add("on");$(a).classList.remove("on");onB()});
}
tabPair("tabSample","tabPaste",
  ()=>{$("respIn").value=JSON.stringify(DEMO_RESPONSE,null,1);analyze()},
  ()=>{$("respIn").value="";$("respIn").placeholder="Paste the full chat.completions response JSON here (with logprobs)…";$("respIn").focus()});
tabPair("tabSynth","tabCsv",
  ()=>{$("csvIn").style.display="none";refit()},
  ()=>{$("csvIn").style.display="block";$("csvIn").focus()});

$("analyze").addEventListener("click",analyze);
$("fit").addEventListener("click",refit);
$("target").addEventListener("input",()=>{$("targetOut").textContent=Math.round($("target").value*100)+"%";refit()});
$("delta").addEventListener("change",refit);
$("yr").textContent=new Date().getFullYear();

// boot
$("respIn").value=JSON.stringify(DEMO_RESPONSE,null,1);
refit();
analyze();
