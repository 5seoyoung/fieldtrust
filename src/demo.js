// Demo fixtures. Everything here is deterministic (seeded PRNG) so the
// jsdom tests can assert on exact numbers.

function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
function demoCalib(){const r=mulberry32(7),s=[],c=[];for(let i=0;i<500;i++){const sc=-3*r();s.push(sc);c.push(r()<1/(1+Math.exp(-(3*sc+5.5))))}return{scores:s,correct:c}}

// OpenAI-shaped token with an optional runner-up logprob.
function tok(t,lp,second){const o={token:t,logprob:lp};if(second!=null)o.top_logprobs=[{token:t,logprob:lp},{token:"·",logprob:second}];return o}
// OpenAI-shaped token with named alternatives: tokA("July", -0.9, [["June", -1.4]]).
function tokA(t,lp,alts){return{token:t,logprob:lp,top_logprobs:[{token:t,logprob:lp},...alts.map(([x,l])=>({token:x,logprob:l}))]}}

// ---------- structured sample (receipt) ----------
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

// ---------- free-text sample (prose) ----------
// A summary where the model is fluent throughout but genuinely unsure about
// two facts - exactly the case the honesty banner is about.
const DEMO_PROSE={choices:[{message:{content:""},logprobs:{content:[
 tokA("The",-0.05,[["Apollo",-3.4]]),tokA(" Apollo",-0.02,[[" the",-4.6]]),tokA(" ",-0.01,[]),
 tokA("11",-0.03,[["1",-4.1]]),tokA(" mission",-0.18,[[" program",-2.4],[" flight",-3.1]]),
 tokA(" landed",-0.31,[[" touched",-2.2],[" reached",-2.9]]),tokA(" on",-0.09,[[" upon",-3.3]]),
 tokA(" the",-0.02,[]),tokA(" Moon",-0.01,[[" lunar",-5.2]]),tokA(" on",-0.22,[[" in",-2.1]]),
 tokA(" July",-0.94,[[" June",-1.28],[" August",-2.6]]),tokA(" ",-0.02,[]),
 tokA("20",-1.32,[["21",-1.41],["16",-2.8]]),tokA(",",-0.03,[]),tokA(" ",-0.01,[]),
 tokA("196",-0.02,[["197",-4.9]]),tokA("9",-0.01,[["8",-5.5]]),tokA(".",-0.08,[]),
 tokA(" The",-0.24,[[" Its",-2.3],[" Crew",-3.0]]),tokA(" crew",-0.11,[[" mission",-2.7]]),
 tokA(" consisted",-0.71,[[" included",-1.1],[" was",-2.4]]),tokA(" of",-0.01,[]),
 tokA(" Neil",-0.06,[[" Commander",-3.2]]),tokA(" Armstrong",-0.01,[]),tokA(",",-0.04,[]),
 tokA(" Buzz",-0.05,[[" Edwin",-3.4]]),tokA(" Aldrin",-0.01,[]),tokA(",",-0.12,[[" and",-2.2]]),
 tokA(" and",-0.02,[]),tokA(" Michael",-0.04,[[" Mike",-3.6]]),tokA(" Collins",-0.01,[]),tokA(".",-0.05,[]),
 tokA(" The",-0.35,[[" It",-1.6],[" Armstrong",-2.9]]),tokA(" mission",-0.29,[[" flight",-1.9]]),
 tokA(" lasted",-0.42,[[" took",-1.8],[" spanned",-2.5]]),
 tokA(" approximately",-1.51,[[" about",-0.86],[" roughly",-2.2]]),tokA(" ",-0.02,[]),
 tokA("8",-1.64,[["9",-1.12],["12",-2.4]]),tokA(" days",-0.07,[[" hours",-3.8]]),tokA(".",-0.04,[])
]}}]};

// ---------- demo batch (JSONL) ----------
// 120 receipts from a pipeline where `date` is structurally weak and
// `currency` is nearly always certain.
function demoBatch(n){
  const r=mulberry32(11),VEND=["Starbucks","Blue Bottle","Peet's Coffee","Costa","Tim Hortons"],lines=[];
  for(let i=0;i<(n||120);i++){
    const T=[],add=(text,scale)=>{const l=-r()*scale;T.push(tok(text,l,l-0.4-r()*3.5))},
      lit=text=>T.push(tok(text,-0.001));
    const mm=String(1+Math.floor(r()*12)).padStart(2,"0"),dd=String(1+Math.floor(r()*31)).padStart(2,"0");
    // separators ride along with the value tokens, the way a BPE tokenizer
    // emits "-02-" - keeping them separate would dilute the field score with
    // near-deterministic punctuation.
    lit('{"vendor": "');add(VEND[Math.floor(r()*VEND.length)],0.34);
    lit('", "date": "');add("2024",0.06);add("-"+mm,2.6);add("-"+dd,2.9);
    lit('", "total": ');add(String(3+Math.floor(r()*40)),0.55);add("."+String(10+Math.floor(r()*89)),0.95);
    lit(', "currency": "');add(r()<0.85?"USD":"EUR",0.07);lit('"}');
    lines.push(JSON.stringify({id:`doc-${i+1}`,response:{choices:[{logprobs:{content:T}}]}}));
  }
  return lines.join("\n");
}
