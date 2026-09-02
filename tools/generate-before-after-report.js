#!/usr/bin/env node
/**
 * tools/generate-before-after-report.js
 *
 * Generates before/after comparison reports from the Stage 2 baseline
 * and the Stage 3 fixed evaluation results.
 *
 * Outputs:
 *   reports/context-retrieval-before-after.html
 *   reports/context-retrieval-before-after.pdf  (HTML fallback)
 *   reports/context-retrieval-before-after.png  (SVG)
 *   reports/context-retrieval-before-after.csv
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname }                        from "node:path";
import { fileURLToPath }                           from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const ROOT       = resolve(__dirname, "..");
const REPORTS    = resolve(ROOT, "reports");
mkdirSync(REPORTS, { recursive: true });

// ─── Load after results ───────────────────────────────────────────────────────
const afterRaw = JSON.parse(readFileSync(resolve(REPORTS, "context-retrieval-raw-results.json"), "utf8"));
const afterAgg = afterRaw.aggregate;
const afterQ   = afterRaw.evaluated;

// ─── Baseline (Stage 2, run 2026-09-01T12:34:01.269Z) ────────────────────────
const BEFORE_AGG = {
  runTimestamp: "2026-09-01T12:34:01.269Z",
  totalQueries: 40, totalExpected: 104, totalFetched: 291,
  totalTP: 30, totalFP: 261, totalFN: 74,
  overallPrecision: 0.1031, overallRecall: 0.2885, overallF1: 0.1519,
  macroF1: 0.2581
};

const BEFORE_Q = {
  Q01:{tp:0,fp:4 ,fn:2},Q02:{tp:0,fp:4 ,fn:3},Q03:{tp:0,fp:2 ,fn:1},Q04:{tp:0,fp:5 ,fn:2},
  Q05:{tp:0,fp:8 ,fn:3},Q06:{tp:0,fp:8 ,fn:4},Q07:{tp:1,fp:7 ,fn:3},Q08:{tp:0,fp:8 ,fn:1},
  Q09:{tp:0,fp:5 ,fn:2},Q10:{tp:0,fp:8 ,fn:2},Q11:{tp:1,fp:7 ,fn:0},Q12:{tp:1,fp:7 ,fn:1},
  Q13:{tp:1,fp:7 ,fn:1},Q14:{tp:1,fp:7 ,fn:0},Q15:{tp:2,fp:6 ,fn:1},Q16:{tp:1,fp:7 ,fn:0},
  Q17:{tp:1,fp:7 ,fn:1},Q18:{tp:1,fp:7 ,fn:1},Q19:{tp:1,fp:7 ,fn:1},Q20:{tp:2,fp:6 ,fn:1},
  Q21:{tp:0,fp:8 ,fn:3},Q22:{tp:1,fp:7 ,fn:2},Q23:{tp:0,fp:6 ,fn:3},Q24:{tp:1,fp:7 ,fn:2},
  Q25:{tp:3,fp:5 ,fn:0},Q26:{tp:2,fp:6 ,fn:0},Q27:{tp:1,fp:7 ,fn:0},Q28:{tp:1,fp:7 ,fn:0},
  Q29:{tp:1,fp:6 ,fn:3},Q30:{tp:0,fp:8 ,fn:2},Q31:{tp:2,fp:6 ,fn:0},Q32:{tp:0,fp:5 ,fn:5},
  Q33:{tp:0,fp:5 ,fn:5},Q34:{tp:3,fp:5 ,fn:2},Q35:{tp:0,fp:8 ,fn:4},Q36:{tp:0,fp:8 ,fn:1},
  Q37:{tp:0,fp:8 ,fn:4},Q38:{tp:0,fp:8 ,fn:1},Q39:{tp:1,fp:7 ,fn:4},Q40:{tp:1,fp:7 ,fn:3}
};

// ─── Build comparison objects ─────────────────────────────────────────────────
const compared = afterQ.map(q => {
  const b = BEFORE_Q[q.queryId];
  const atp = q.tp.length, afp = q.fp.length, afn = q.fn.length;
  const bp = b.tp>0||(b.tp+b.fp)>0 ? b.tp/(b.tp+b.fp)||null : null;
  const br = b.tp>0||(b.tp+b.fn)>0 ? b.tp/(b.tp+b.fn)||null : null;
  const bf1 = bp&&br&&(bp+br)>0 ? 2*bp*br/(bp+br) : null;
  return {
    queryId: q.queryId, category: q.category, query: q.query,
    expectedIds: q.expectedIds,
    beforeTP: b.tp, beforeFP: b.fp, beforeFN: b.fn,
    beforeP: bp, beforeR: br, beforeF1: bf1,
    afterTP: atp, afterFP: afp, afterFN: afn,
    afterP: q.precision, afterR: q.recall, afterF1: q.f1,
    afterTPIds: q.tp, afterFPIds: q.fp, afterFNIds: q.fn,
    afterFetched: q.fetchedIds,
    deltaTP: atp - b.tp
  };
});

const pct = v => v!=null ? (v*100).toFixed(2)+"%" : "N/A";
const pct1 = v => v!=null ? (v*100).toFixed(1)+"%" : "N/A";

// ─── CSV ──────────────────────────────────────────────────────────────────────
const esc = v => { const s=String(v??""); return (s.includes(",")||s.includes('"'))?`"${s.replace(/"/g,'""')}"`  :s; };

const csvLines = [
  "QueryID,Category,Query,Expected,BeforeTP,BeforeFP,BeforeFN,BeforeP%,BeforeR%,BeforeF1%,AfterTP,AfterFP,AfterFN,AfterP%,AfterR%,AfterF1%,DeltaTP",
  ...compared.map(r => [
    r.queryId, r.category, esc(r.query), r.expectedIds.length,
    r.beforeTP, r.beforeFP, r.beforeFN,
    r.beforeP!=null?(r.beforeP*100).toFixed(2):"",
    r.beforeR!=null?(r.beforeR*100).toFixed(2):"",
    r.beforeF1!=null?(r.beforeF1*100).toFixed(2):"",
    r.afterTP, r.afterFP, r.afterFN,
    r.afterP!=null?(r.afterP*100).toFixed(2):"",
    r.afterR!=null?(r.afterR*100).toFixed(2):"",
    r.afterF1!=null?(r.afterF1*100).toFixed(2):"",
    r.deltaTP>=0?`+${r.deltaTP}`:String(r.deltaTP)
  ].join(",")),
  "",
  `AGGREGATE,,${esc("")},${BEFORE_AGG.totalExpected},${BEFORE_AGG.totalTP},${BEFORE_AGG.totalFP},${BEFORE_AGG.totalFN},${(BEFORE_AGG.overallPrecision*100).toFixed(2)},${(BEFORE_AGG.overallRecall*100).toFixed(2)},${(BEFORE_AGG.overallF1*100).toFixed(2)},${afterAgg.totalTP},${afterAgg.totalFP},${afterAgg.totalFN},${(afterAgg.overallPrecision*100).toFixed(2)},${(afterAgg.overallRecall*100).toFixed(2)},${(afterAgg.overallF1*100).toFixed(2)},+${afterAgg.totalTP-BEFORE_AGG.totalTP}`
];
writeFileSync(resolve(REPORTS,"context-retrieval-before-after.csv"), csvLines.join("\n"), "utf8");
console.log("  📊  CSV written");

// ─── SVG visualization ────────────────────────────────────────────────────────
const W=1400, BH=200; // chart dimensions
const bw = Math.floor((W-80)/compared.length);

function fbar(r, isBefore) {
  const f1 = isBefore ? (r.beforeF1??0) : (r.afterF1??0);
  const h  = Math.max(2, f1*BH);
  const i  = compared.indexOf(r);
  const x  = 60 + i*bw + (isBefore ? 0 : Math.floor(bw/2));
  const y  = 370 - h;
  const w  = Math.floor(bw/2)-1;
  const c  = isBefore
    ? (f1>=0.5?"#3b82f6":f1>=0.2?"#60a5fa":"#1e3a5f")
    : (f1>=0.5?"#22c55e":f1>=0.2?"#86efac":"#14532d");
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${c}"/>`;
}

const grid = [0,25,50,75,100].map(p=>{
  const y = 370-Math.round(p/100*BH);
  return `<line x1="55" y1="${y}" x2="${W-10}" y2="${y}" stroke="#1e293b" stroke-width="1"/>
          <text x="10" y="${y+4}" font-size="9" fill="#64748b">${p}%</text>`;
}).join("\n");

const bars   = compared.map(r => fbar(r,true)+"\n"+fbar(r,false)).join("\n");
const labels = compared.map((r,i) => {
  const x = 60+i*bw+bw/2;
  return `<text x="${x}" y="387" font-size="7" fill="#94a3b8" transform="rotate(-45 ${x} 384)" text-anchor="end">${r.queryId}</text>`;
}).join("\n");
const deltas = compared.filter(r=>r.deltaTP!==0).map(r=>{
  const i=compared.indexOf(r);
  const x=60+i*bw+bw/2;
  return `<text x="${x}" y="322" font-size="8" fill="${r.deltaTP>0?"#22c55e":"#ef4444"}" text-anchor="middle" font-weight="bold">${r.deltaTP>0?'+':''}${r.deltaTP}</text>`;
}).join("\n");

const tpW = v => Math.round(v/104*700);
const svgH = 740;
const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${svgH}" style="background:#0f172a">
  <text x="40" y="38" font-size="20" font-weight="bold" fill="#e2e8f0">Neura AI — Retrieval Improvement: Before vs After</text>
  <text x="40" y="60" font-size="12" fill="#64748b">40 queries · 104 expected · Same ground truth · 3 fixes applied</text>

  ${[
    {lbl:"BEFORE Precision", val:BEFORE_AGG.overallPrecision, x:40,  clr:"#3b82f6"},
    {lbl:"AFTER Precision",  val:afterAgg.overallPrecision,   x:220, clr:"#22c55e"},
    {lbl:"BEFORE Recall",    val:BEFORE_AGG.overallRecall,    x:400, clr:"#3b82f6"},
    {lbl:"AFTER Recall",     val:afterAgg.overallRecall,      x:580, clr:"#22c55e"},
    {lbl:"BEFORE F1",        val:BEFORE_AGG.overallF1,        x:760, clr:"#3b82f6"},
    {lbl:"AFTER F1",         val:afterAgg.overallF1,          x:940, clr:"#22c55e"},
    {lbl:"TP: ${BEFORE_AGG.totalTP}→${afterAgg.totalTP} (+${afterAgg.totalTP-BEFORE_AGG.totalTP})", val:(afterAgg.totalTP-BEFORE_AGG.totalTP)/104, x:1120, clr:"#f59e0b"},
  ].map(c=>`
    <rect x="${c.x}" y="78" width="165" height="78" rx="7" fill="${c.clr}22" stroke="${c.clr}" stroke-width="2"/>
    <text x="${c.x+12}" y="120" font-size="24" font-weight="bold" font-family="monospace" fill="${c.clr}">${pct1(c.val)}</text>
    <text x="${c.x+12}" y="146" font-size="10" fill="#64748b">${c.lbl}</text>`).join("")}

  <text x="40" y="187" font-size="12" font-weight="bold" fill="#e2e8f0">TP retrieved vs expected (104 total)</text>
  <rect x="40" y="196" width="${tpW(BEFORE_AGG.totalTP)}" height="22" fill="#3b82f6" opacity="0.8"/>
  <text x="${42+tpW(BEFORE_AGG.totalTP)}" y="212" font-size="11" fill="#3b82f6">  BEFORE: ${BEFORE_AGG.totalTP}/104</text>
  <rect x="40" y="222" width="${tpW(afterAgg.totalTP)}"  height="22" fill="#22c55e" opacity="0.8"/>
  <text x="${42+tpW(afterAgg.totalTP)}"  y="238" font-size="11" fill="#22c55e">  AFTER: ${afterAgg.totalTP}/104  (+${afterAgg.totalTP-BEFORE_AGG.totalTP})</text>

  <text x="40" y="268" font-size="12" font-weight="bold" fill="#e2e8f0">Per-Query F1: BEFORE (blue) vs AFTER (green). Numbers = TP delta.</text>
  ${grid}
  ${bars}
  ${deltas}
  ${labels}

  <rect x="40" y="415" width="16" height="12" fill="#3b82f6"/>
  <text x="62" y="427" font-size="11" fill="#e2e8f0">BEFORE F1</text>
  <rect x="175" y="415" width="16" height="12" fill="#22c55e"/>
  <text x="197" y="427" font-size="11" fill="#e2e8f0">AFTER F1</text>
  <text x="330" y="427" font-size="11" fill="#22c55e">▲ = TP gained</text>
  <text x="450" y="427" font-size="11" fill="#ef4444">▼ = TP lost</text>

  <text x="40" y="462" font-size="12" font-weight="bold" fill="#e2e8f0">Fixes</text>
  <rect x="40" y="470" width="${W-80}" height="60" rx="6" fill="#1e293b"/>
  <text x="55" y="490" font-size="10" fill="#22c55e" font-weight="bold">RC1:</text>
  <text x="90" y="490" font-size="10" fill="#94a3b8">Added userId-scoped filter to Qdrant queryQdrantPoints() — scopes search to each user's memories, eliminates cross-user noise</text>
  <text x="55" y="508" font-size="10" fill="#22c55e" font-weight="bold">RC2:</text>
  <text x="90" y="508" font-size="10" fill="#94a3b8">factual-memory-store.findRelevant() now computes cosine similarity against stored embeddings — factual memories get a real vectorScore (was hardcoded 0)</text>
  <text x="55" y="526" font-size="10" fill="#22c55e" font-weight="bold">RC3:</text>
  <text x="90" y="526" font-size="10" fill="#94a3b8">Postgres SQL orders by ts_rank DESC first; passes gate raised to importance ≥ 0.85 (was 0.65) — stops unrelated high-importance memories flooding results</text>

  <text x="40" y="562" font-size="12" font-weight="bold" fill="#e2e8f0">Queries with changes (▲ improved / ▼ regressed)</text>
  ${compared.filter(r=>r.deltaTP!==0).map((r,i)=>{
    const row=Math.floor(i/5), col=i%5;
    const x=40+col*270, y=578+row*46;
    const c=r.deltaTP>0?"#22c55e":"#ef4444";
    const sym=r.deltaTP>0?"▲":"▼";
    const af1=r.afterF1!=null?(r.afterF1*100).toFixed(0)+"%":"N/A";
    return `<rect x="${x}" y="${y}" width="262" height="40" rx="5" fill="#1e293b"/>
      <text x="${x+8}" y="${y+16}" font-size="11" font-weight="bold" fill="${c}">${sym} ${r.queryId}</text>
      <text x="${x+68}" y="${y+16}" font-size="9" fill="#94a3b8">${r.query.slice(0,34)}${r.query.length>34?"…":""}</text>
      <text x="${x+8}" y="${y+32}" font-size="9" fill="${c}">TP:${r.beforeTP}→${r.afterTP}  F1:${af1}</text>`;
  }).join("\n")}
</svg>`;
writeFileSync(resolve(REPORTS,"context-retrieval-before-after.png"), svg, "utf8");
console.log("  🖼   SVG/PNG written");

// ─── HTML ─────────────────────────────────────────────────────────────────────
const tableRows = compared.map(r=>{
  const cat = r.deltaTP>0?"improved":r.deltaTP<0?"regression":"stable";
  const badge = r.deltaTP>0
    ? `<span style="background:#14532d;color:#22c55e;padding:2px 7px;border-radius:4px;font-size:.78em;font-weight:700">▲+${r.deltaTP}</span>`
    : r.deltaTP<0
    ? `<span style="background:#450a0a;color:#ef4444;padding:2px 7px;border-radius:4px;font-size:.78em;font-weight:700">▼${r.deltaTP}</span>`
    : `<span style="color:#64748b;font-size:.8em">=</span>`;
  return `<tr class="${cat}">
    <td><code>${r.queryId}</code></td>
    <td style="font-size:.78em;color:#94a3b8">${r.category}</td>
    <td style="text-align:center">${r.expectedIds.length}</td>
    <td style="text-align:center;color:#60a5fa">${r.beforeTP}</td>
    <td style="text-align:center;color:#60a5fa">${r.beforeFP}</td>
    <td style="text-align:center;color:#60a5fa">${r.beforeFN}</td>
    <td style="text-align:center;color:#60a5fa">${pct(r.beforeF1)}</td>
    <td style="text-align:center;color:#22c55e">${r.afterTP}</td>
    <td style="text-align:center;color:#22c55e">${r.afterFP}</td>
    <td style="text-align:center;color:#22c55e">${r.afterFN}</td>
    <td style="text-align:center;color:#22c55e">${pct(r.afterF1)}</td>
    <td style="text-align:center">${badge}</td>
  </tr>`;
}).join("\n");

// 12 representative queries: improvements, stable, regressions, failures
const showQids=["Q01","Q05","Q06","Q07","Q10","Q13","Q18","Q25","Q34","Q35","Q20","Q39"];
const showQBlocks = compared.filter(r=>showQids.includes(r.queryId)).map(r=>{
  const cat = r.deltaTP>0?"improved":r.deltaTP<0?"regression":"stable";
  const headerColor = cat==="improved"?"#22c55e":cat==="regression"?"#ef4444":"#3b82f6";
  const deltaLabel = r.deltaTP>0?`▲ +${r.deltaTP} TP gained`:r.deltaTP<0?`▼ ${r.deltaTP} TP lost`:"= No TP change";
  return `<div style="border-left:4px solid ${headerColor};background:#1e293b;border-radius:8px;padding:16px;margin-bottom:16px">
  <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:10px">
    <code style="background:#3b82f6;color:#fff;padding:2px 8px;border-radius:4px">${r.queryId}</code>
    <span style="font-size:.8em;color:#64748b;background:#334155;padding:2px 8px;border-radius:4px">${r.category}</span>
    <span style="font-size:.82em;font-weight:700;color:${headerColor}">${deltaLabel}</span>
  </div>
  <div style="margin-bottom:12px"><strong>Query:</strong> ${r.query}</div>
  <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px">
    <div>
      <div style="font-size:.72em;font-weight:700;text-transform:uppercase;color:#64748b;margin-bottom:4px">Expected (${r.expectedIds.length})</div>
      ${r.expectedIds.map(id=>`<span style="display:inline-block;padding:2px 7px;margin:2px;border-radius:4px;font-size:.8em;background:#1e3a5f;border:1px solid #3b82f633">${id}</span>`).join("")}
    </div>
    <div>
      <div style="font-size:.72em;font-weight:700;text-transform:uppercase;color:#64748b;margin-bottom:4px">Before Fetched (TP:${r.beforeTP} FP:${r.beforeFP} FN:${r.beforeFN})</div>
      ${r.beforeTP>0?"<div style='font-size:.8em;color:#3b82f6'>"+pct(r.beforeF1)+" F1</div>":"<div style='font-size:.8em;color:#ef4444'>0 TP retrieved</div>"}
    </div>
    <div>
      <div style="font-size:.72em;font-weight:700;text-transform:uppercase;color:#64748b;margin-bottom:4px">After Fetched (TP:${r.afterTP} FP:${r.afterFP} FN:${r.afterFN})</div>
      ${r.afterFetched.map(id=>{
        const isTp=r.afterTPIds.includes(id);
        return `<span style="display:inline-block;padding:2px 7px;margin:2px;border-radius:4px;font-size:.8em;${isTp?"background:#14532d;border:1px solid #22c55e;color:#22c55e":"background:#450a0a;border:1px solid #ef444466;color:#ef4444"}">${id}${isTp?" ✓":" ✗"}</span>`;
      }).join("")}
      <div style="font-size:.78em;color:#94a3b8;margin-top:4px">P:${pct(r.afterP)} R:${pct(r.afterR)} F1:${pct(r.afterF1)}</div>
    </div>
  </div>
</div>`;
}).join("\n");

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Neura AI — Retrieval Before vs After</title>
<style>
:root{--bg:#0f172a;--bg2:#1e293b;--text:#e2e8f0;--muted:#64748b;--success:#22c55e;--danger:#ef4444;--blue:#3b82f6}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:'Segoe UI',system-ui,sans-serif;line-height:1.6}
.container{max-width:1400px;margin:0 auto;padding:24px}
h1{font-size:1.8rem;font-weight:800;margin-bottom:6px}
h2{font-size:1.25rem;font-weight:700;border-bottom:2px solid #334155;padding-bottom:6px;margin-bottom:16px}
section{background:var(--bg2);border-radius:12px;padding:22px;margin-bottom:28px}
.hero{background:linear-gradient(135deg,#1e293b,#0f172a,#1e1b4b)}
table{width:100%;border-collapse:collapse;font-size:.84em}
th{background:#334155;padding:9px 10px;text-align:left;white-space:nowrap}
td{padding:7px 10px;border-bottom:1px solid #1e293b;vertical-align:middle}
.improved td:first-child{border-left:3px solid var(--success)}
.regression td:first-child{border-left:3px solid var(--danger)}
.stable td:first-child{border-left:3px solid var(--blue)}
code{font-family:monospace;background:#334155;padding:2px 6px;border-radius:4px;font-size:.85em}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:20px}
.card{border-radius:10px;padding:16px;text-align:center;border:2px solid}
.card-val{font-size:2rem;font-weight:800;font-family:monospace}
.card.b{border-color:var(--blue);background:#1e3a5f33}.card.b .card-val{color:#60a5fa}
.card.a{border-color:var(--success);background:#14532d33}.card.a .card-val{color:var(--success)}
.card.d{border-color:#f59e0b;background:#45180033}.card.d .card-val{color:#f59e0b}
.card-lbl{font-size:.78em;color:var(--muted);margin-top:3px}
img{max-width:100%;border-radius:8px}
</style>
</head>
<body>
<div class="container">
<section class="hero">
  <h1>🔧 Neura AI — Retrieval Improvement Report</h1>
  <p style="color:#64748b;margin-top:6px">Stage 3: Three root-cause fixes applied. Same 40 queries · same 160 memories · same ground truth as Stage 2 baseline.</p>
  <p style="color:#94a3b8;font-size:.85em;margin-top:4px">Before: ${BEFORE_AGG.runTimestamp} · After: ${afterAgg.runTimestamp}</p>
</section>

<section>
  <h2>📊 Aggregate Metrics</h2>
  <div class="cards">
    <div class="card b"><div class="card-val">${pct1(BEFORE_AGG.overallPrecision)}</div><div class="card-lbl">BEFORE Precision</div></div>
    <div class="card a"><div class="card-val">${pct1(afterAgg.overallPrecision)}</div><div class="card-lbl">AFTER Precision</div></div>
    <div class="card d"><div class="card-val">+${(afterAgg.overallPrecision*100-BEFORE_AGG.overallPrecision*100).toFixed(1)}%</div><div class="card-lbl">Precision Δ</div></div>
    <div class="card b"><div class="card-val">${pct1(BEFORE_AGG.overallRecall)}</div><div class="card-lbl">BEFORE Recall</div></div>
    <div class="card a"><div class="card-val">${pct1(afterAgg.overallRecall)}</div><div class="card-lbl">AFTER Recall</div></div>
    <div class="card d"><div class="card-val">+${(afterAgg.overallRecall*100-BEFORE_AGG.overallRecall*100).toFixed(1)}%</div><div class="card-lbl">Recall Δ (+21pp)</div></div>
    <div class="card b"><div class="card-val">${pct1(BEFORE_AGG.overallF1)}</div><div class="card-lbl">BEFORE F1</div></div>
    <div class="card a"><div class="card-val">${pct1(afterAgg.overallF1)}</div><div class="card-lbl">AFTER F1</div></div>
    <div class="card d"><div class="card-val">+${(afterAgg.overallF1*100-BEFORE_AGG.overallF1*100).toFixed(1)}%</div><div class="card-lbl">F1 Δ</div></div>
  </div>
  <table>
    <tr><th>Metric</th><th style="color:#60a5fa">BEFORE</th><th style="color:#22c55e">AFTER</th><th>Δ</th></tr>
    ${[
      ["Queries",BEFORE_AGG.totalQueries,afterAgg.totalQueries,"0","#94a3b8"],
      ["Expected items",BEFORE_AGG.totalExpected,afterAgg.totalExpected,"0","#94a3b8"],
      ["Fetched items",BEFORE_AGG.totalFetched,afterAgg.totalFetched,afterAgg.totalFetched-BEFORE_AGG.totalFetched>=0?`+${afterAgg.totalFetched-BEFORE_AGG.totalFetched}`:`${afterAgg.totalFetched-BEFORE_AGG.totalFetched}`,"#f59e0b"],
      ["TP ✓",BEFORE_AGG.totalTP,afterAgg.totalTP,`+${afterAgg.totalTP-BEFORE_AGG.totalTP}`,"#22c55e"],
      ["FP ✗",BEFORE_AGG.totalFP,afterAgg.totalFP,afterAgg.totalFP-BEFORE_AGG.totalFP>=0?`+${afterAgg.totalFP-BEFORE_AGG.totalFP}`:`${afterAgg.totalFP-BEFORE_AGG.totalFP}`,"#f59e0b"],
      ["FN ⚠",BEFORE_AGG.totalFN,afterAgg.totalFN,`-${BEFORE_AGG.totalFN-afterAgg.totalFN}`,"#22c55e"],
      ["Micro-Precision",(BEFORE_AGG.overallPrecision*100).toFixed(2)+"%",(afterAgg.overallPrecision*100).toFixed(2)+"%",`+${(afterAgg.overallPrecision*100-BEFORE_AGG.overallPrecision*100).toFixed(2)}pp`,"#22c55e"],
      ["Micro-Recall",(BEFORE_AGG.overallRecall*100).toFixed(2)+"%",(afterAgg.overallRecall*100).toFixed(2)+"%",`+${(afterAgg.overallRecall*100-BEFORE_AGG.overallRecall*100).toFixed(2)}pp`,"#22c55e"],
      ["Micro-F1",(BEFORE_AGG.overallF1*100).toFixed(2)+"%",(afterAgg.overallF1*100).toFixed(2)+"%",`+${(afterAgg.overallF1*100-BEFORE_AGG.overallF1*100).toFixed(2)}pp`,"#22c55e"],
    ].map(([m,b,a,d,dc])=>`<tr><td>${m}</td><td style="color:#60a5fa;text-align:center">${b}</td><td style="color:#22c55e;text-align:center">${a}</td><td style="color:${dc};text-align:center;font-weight:700">${d}</td></tr>`).join("")}
  </table>
</section>

<section>
  <h2>🔧 Changes Made</h2>
  ${[
    ["RC1 — Qdrant userId filter","qdrant-client.js · vector-memory-store.js",
     "<code>queryQdrantPoints()</code> now accepts <code>userId</code>. When present, applies a Qdrant keyword filter: <code>{ must: [{ key: 'userId', match: { value: userId } }] }</code>. Scopes vector search to the current user's memories, eliminating cross-user noise while preserving cross-session recall for the same user. The <code>userId</code> payload index is created in <code>ensureQdrantReady()</code>. A graceful fallback retries without the filter if the index doesn't exist yet on an older collection."],
    ["RC2 — Factual memory vector scores","factual-memory-store.js · candidateFetcher.js",
     "<code>factualMemoryStore.findRelevant()</code> accepts a new <code>queryEmbedding</code> parameter. When a stored embedding exists in the Postgres <code>embedding</code> column, cosine similarity is computed and used as <code>vectorScore</code> — previously hardcoded to 0. This gives factual memories access to the 40% vector weight in the hybrid scoring formula. <code>candidateFetcher.js</code> passes the pre-computed query embedding through. A one-time backfill script (<code>tools/backfill-factual-embeddings.js</code>) generated and stored embeddings for the 90 seeded factual memories."],
    ["RC3 — Postgres relevance gate","factual-memory-store.js",
     "SQL now orders by <code>ts_rank DESC, importance DESC</code> (FTS relevance first). The <code>passes</code> filter was tightened: a factual memory now requires <code>lexicalScore > 0 OR vectorScore > 0.15 OR importance ≥ 0.85</code> (was <code>importance ≥ 0.65</code>). This stops topically-unrelated high-importance memories from dominating the candidate pool."],
  ].map(([title,files,desc])=>`<div style="background:#334155;border-radius:8px;padding:14px;margin-bottom:10px">
    <div style="font-weight:700;color:#22c55e;margin-bottom:3px">${title}</div>
    <div style="font-size:.8em;color:#64748b;margin-bottom:6px">Files: ${files}</div>
    <p style="font-size:.9em">${desc}</p>
  </div>`).join("")}
</section>

<section>
  <h2>📉 Before vs After Visualization</h2>
  <img src="context-retrieval-before-after.png" alt="Before vs After">
</section>

<section>
  <h2>🔍 Representative Query Examples (12 of 40)</h2>
  ${showQBlocks}
</section>

<section>
  <h2>📋 Full Per-Query Table</h2>
  <div style="overflow-x:auto">
  <table>
    <tr>
      <th>ID</th><th>Category</th><th>Exp</th>
      <th colspan="4" style="color:#60a5fa;text-align:center">BEFORE: TP / FP / FN / F1</th>
      <th colspan="4" style="color:#22c55e;text-align:center">AFTER: TP / FP / FN / F1</th>
      <th>Δ</th>
    </tr>
    ${tableRows}
  </table>
  </div>
</section>

<section>
  <h2>⚠️ Remaining Failures and Limitations</h2>
  <ul style="padding-left:20px;line-height:2;font-size:.9em">
    <li><strong>Q09</strong> (testing tools): eval-f036/eval-f028 have embeddings now but "testing tools frameworks" lacks strong keyword OR semantic overlap. Would benefit from query expansion.</li>
    <li><strong>Q21/Q23/Q24</strong> (goals session): Factual goal memories retrieved but the importance-vs-recency competition with Qdrant episodic memories still leaves wrong memories in the top-8.</li>
    <li><strong>Q33</strong> (health/fitness routine): 5 expected factual memories — all need to surface simultaneously, but topK=8 is filled by higher-scoring Qdrant results.</li>
    <li><strong>Q36–Q38</strong> (noise/no-memory queries): No strongly-matching memory exists in the corpus for these queries.</li>
    <li><strong>FP still 268</strong>: With topK=8, when only 1–2 relevant memories exist for a query, 6–7 noise slots remain. Enabling <code>RETRIEVAL_TOPICAL_PENALTY_ENABLED=true</code> would address this without changing topK.</li>
    <li><strong>Minor regressions</strong>: Q20 (−1 TP), Q25 (−1 TP), Q31 (−1 TP), Q39 (−1 TP) — the RC1 userId filter slightly changes Qdrant ranking order, displacing one previously-lucky TP in a few queries.</li>
  </ul>
</section>

</div>
</body>
</html>`;
writeFileSync(resolve(REPORTS,"context-retrieval-before-after.html"), html, "utf8");
writeFileSync(resolve(REPORTS,"context-retrieval-before-after.pdf"), html, "utf8");
console.log("  🌐  HTML written");
console.log("  📄  PDF written (HTML fallback)");
console.log("\n  ✅  All before-after reports generated.\n");
