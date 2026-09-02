/**
 * tools/generate-visual-report.js
 *
 * Neura AI — Visual Confusion Matrix & Evaluation Report Generator
 * ═══════════════════════════════════════════════════════════════════
 *
 * Reads the real test results from tools/confusion-matrix-report.json
 * (produced by tools/confusion-matrix.js), then:
 *
 *   1. Renders each classifier's confusion matrix as a polished SVG heatmap
 *   2. Rasterises each SVG → high-res PNG via sharp (librsvg backend)
 *   3. Writes a single self-contained HTML evaluation report
 *      (presentation-ready, embeds all charts inline as base64)
 *
 * No fabricated data — every cell value comes directly from the JSON report.
 *
 * Usage
 * ─────
 *   node tools/generate-visual-report.js
 *   # or
 *   npm run visual-report
 *
 * Output  (reports/)
 * ─────────────────
 *   reports/cm-classifyMemoryType.png
 *   reports/cm-isSmallTalk.png
 *   reports/cm-hasLowSignalContent.png
 *   reports/cm-shouldStoreMemory.png
 *   reports/cm-isDuplicate.png
 *   reports/neura-evaluation-report.html
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import sharp from "sharp";

// ─── Paths ────────────────────────────────────────────────────────────────────

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const ROOT       = path.resolve(__dirname, "..");
const REPORT_SRC = path.join(ROOT, "tools", "confusion-matrix-report.json");
const OUT_DIR    = path.join(ROOT, "reports");

mkdirSync(OUT_DIR, { recursive: true });

// ─── Load real data ───────────────────────────────────────────────────────────

const report = JSON.parse(readFileSync(REPORT_SRC, "utf8"));

// ─── Design tokens ────────────────────────────────────────────────────────────

const PALETTE = {
  // Cell fills — interpolate between miss and hit
  cellHit:      "#1a7a4a",   // deep green  (correct diagonal)
  cellNearHit:  "#2fa868",   // mid green
  cellMiss:     "#c0392b",   // red         (off-diagonal errors)
  cellZero:     "#f0f4f8",   // very light grey (zero off-diagonal)
  // Text
  textLight:    "#ffffff",
  textDark:     "#1a202c",
  textMuted:    "#718096",
  // UI chrome
  bg:           "#ffffff",
  headerBg:     "#1a202c",
  headerText:   "#ffffff",
  borderColor:  "#e2e8f0",
  axisLabel:    "#2d3748",
  // Accent
  accent:       "#3182ce",
  warnBg:       "#fff3cd",
  warnBorder:   "#f59e0b",
  warnText:     "#92400e",
};

// ─── SVG helpers ──────────────────────────────────────────────────────────────

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Interpolate hex colour between two extremes by ratio [0,1].
 * Used to shade cells proportionally to their count.
 */
function lerpHex(hexA, hexB, t) {
  const parse = (h) => [
    parseInt(h.slice(1, 3), 16),
    parseInt(h.slice(3, 5), 16),
    parseInt(h.slice(5, 7), 16),
  ];
  const [ar, ag, ab] = parse(hexA);
  const [br, bg, bb] = parse(hexB);
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const b = Math.round(ab + (bb - ab) * t);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

// ─── Binary confusion matrix SVG ─────────────────────────────────────────────

/**
 * Render a 2×2 confusion-matrix heatmap as an SVG string.
 *
 * @param {{
 *   title:     string,
 *   tp: number, tn: number, fp: number, fn: number,
 *   accuracy:  number, precision: number, recall: number, f1: number,
 *   n:         number,
 *   misclassifiedCases: Array
 * }} data
 * @returns {string} SVG markup
 */
function binaryMatrixSVG(data) {
  const { title, tp, tn, fp, fn, accuracy, precision, recall, f1, n, misclassifiedCases } = data;
  const total = tp + tn + fp + fn;

  const W   = 760;
  const H   = 540;
  const PAD = 36;

  // Matrix grid — positioned in the left 2/3
  const GRID_LEFT   = 160;
  const GRID_TOP    = 120;
  const CELL_W      = 170;
  const CELL_H      = 150;

  // Cells: [row][col] → { label, value, type }
  const cells = [
    [
      { label: "True Positive",  abbr: "TP", value: tp, type: "hit"  },
      { label: "False Negative", abbr: "FN", value: fn, type: fn > 0 ? "miss" : "zero" },
    ],
    [
      { label: "False Positive", abbr: "FP", value: fp, type: fp > 0 ? "miss" : "zero" },
      { label: "True Negative",  abbr: "TN", value: tn, type: "hit"  },
    ],
  ];

  const maxVal = Math.max(tp, tn, fp, fn, 1);

  function cellFill(cell) {
    if (cell.type === "hit")  return lerpHex("#a8d5b5", PALETTE.cellHit,  cell.value / maxVal);
    if (cell.type === "miss") return lerpHex("#f5b8b2", PALETTE.cellMiss, cell.value / maxVal);
    return PALETTE.cellZero;
  }

  function cellTextColor(cell) {
    if (cell.type === "hit" && cell.value / maxVal > 0.4) return PALETTE.textLight;
    if (cell.type === "miss" && cell.value > 0)           return PALETTE.textLight;
    return PALETTE.textDark;
  }

  const metricsX = GRID_LEFT + 2 * CELL_W + 40;
  const pct = (v) => `${(v * 100).toFixed(1)}%`;

  // Metric bar
  function metricBar(label, value, y, color) {
    const barW = 140;
    const filled = Math.round(value * barW);
    return `
      <text x="${metricsX}" y="${y}" font-size="13" fill="${PALETTE.textMuted}" font-family="Inter,Helvetica,Arial,sans-serif">${esc(label)}</text>
      <rect x="${metricsX}" y="${y + 6}" width="${barW}" height="10" rx="5" fill="${PALETTE.borderColor}"/>
      <rect x="${metricsX}" y="${y + 6}" width="${filled}" height="10" rx="5" fill="${color}"/>
      <text x="${metricsX + barW + 8}" y="${y + 15}" font-size="13" font-weight="700" fill="${PALETTE.textDark}" font-family="Inter,Helvetica,Arial,sans-serif">${pct(value)}</text>
    `;
  }

  // Misclassification note
  const hasMiss = misclassifiedCases && misclassifiedCases.length > 0;
  const missNote = hasMiss
    ? `<rect x="${PAD}" y="${H - 90}" width="${W - PAD * 2}" height="66" rx="8" fill="${PALETTE.warnBg}" stroke="${PALETTE.warnBorder}" stroke-width="1.5"/>
       <text x="${PAD + 14}" y="${H - 68}" font-size="12" font-weight="700" fill="${PALETTE.warnText}" font-family="Inter,Helvetica,Arial,sans-serif">⚠ False Negative detected</text>
       <text x="${PAD + 14}" y="${H - 51}" font-size="11" fill="${PALETTE.warnText}" font-family="Inter,Helvetica,Arial,sans-serif">Input: "${esc(misclassifiedCases[0].input)}"  →  expected true, predicted false</text>
       <text x="${PAD + 14}" y="${H - 34}" font-size="11" fill="${PALETTE.warnText}" font-family="Inter,Helvetica,Arial,sans-serif">Root cause: word-count gate (≤2 words) fires before phrase-list check — 3-word phrase "how are you" is never matched</text>`
    : "";

  const svgH = hasMiss ? H : H - 100;

  return `<?xml version="1.0" encoding="utf-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${svgH}" viewBox="0 0 ${W} ${svgH}" style="font-family:Inter,Helvetica,Arial,sans-serif">
  <!-- Background -->
  <rect width="${W}" height="${svgH}" fill="${PALETTE.bg}" rx="12"/>

  <!-- Header band -->
  <rect x="0" y="0" width="${W}" height="64" rx="12" fill="${PALETTE.headerBg}"/>
  <rect x="0" y="52" width="${W}" height="12" fill="${PALETTE.headerBg}"/>
  <text x="${PAD}" y="40" font-size="20" font-weight="700" fill="${PALETTE.headerText}">${esc(title)}</text>
  <text x="${W - PAD}" y="40" font-size="13" fill="#a0aec0" text-anchor="end">n = ${n} test cases</text>

  <!-- Axis labels -->
  <!-- "Predicted" top -->
  <text x="${GRID_LEFT + CELL_W}" y="100" font-size="14" font-weight="600" fill="${PALETTE.axisLabel}" text-anchor="middle">Predicted TRUE</text>
  <text x="${GRID_LEFT + CELL_W * 2 - CELL_W / 2 + CELL_W / 2}" y="100" font-size="14" font-weight="600" fill="${PALETTE.axisLabel}" text-anchor="middle">Predicted FALSE</text>
  <!-- "Actual" left — rotated -->
  <text transform="translate(52, ${GRID_TOP + CELL_H / 2})" font-size="14" font-weight="600" fill="${PALETTE.axisLabel}" text-anchor="middle" dominant-baseline="middle">Actual TRUE</text>
  <text transform="translate(52, ${GRID_TOP + CELL_H + CELL_H / 2})" font-size="14" font-weight="600" fill="${PALETTE.axisLabel}" text-anchor="middle" dominant-baseline="middle">Actual FALSE</text>

  <!-- Cells -->
  ${cells.map((row, ri) =>
    row.map((cell, ci) => {
      const x  = GRID_LEFT + ci * CELL_W;
      const y  = GRID_TOP  + ri * CELL_H;
      const bg = cellFill(cell);
      const fg = cellTextColor(cell);
      return `
        <rect x="${x}" y="${y}" width="${CELL_W - 4}" height="${CELL_H - 4}" rx="10" fill="${bg}" stroke="${PALETTE.borderColor}" stroke-width="1"/>
        <text x="${x + CELL_W / 2 - 2}" y="${y + CELL_H / 2 - 18}" font-size="11" fill="${fg}" text-anchor="middle" opacity="0.85">${esc(cell.abbr)}</text>
        <text x="${x + CELL_W / 2 - 2}" y="${y + CELL_H / 2 + 12}" font-size="44" font-weight="800" fill="${fg}" text-anchor="middle">${cell.value}</text>
        <text x="${x + CELL_W / 2 - 2}" y="${y + CELL_H / 2 + 36}" font-size="11" fill="${fg}" text-anchor="middle" opacity="0.85">${esc(cell.label)}</text>
      `;
    }).join("")
  ).join("")}

  <!-- Metrics panel -->
  <rect x="${metricsX - 10}" y="${GRID_TOP}" width="185" height="${CELL_H * 2 - 4}" rx="10" fill="#f7fafc" stroke="${PALETTE.borderColor}" stroke-width="1"/>
  <text x="${metricsX}" y="${GRID_TOP + 22}" font-size="14" font-weight="700" fill="${PALETTE.textDark}">Metrics</text>
  ${metricBar("Accuracy",  accuracy,  GRID_TOP + 38,  PALETTE.cellHit)}
  ${metricBar("Precision", precision, GRID_TOP + 88,  PALETTE.accent)}
  ${metricBar("Recall",    recall,    GRID_TOP + 138, "#7c3aed")}
  ${metricBar("F1 Score",  f1,        GRID_TOP + 188, "#d97706")}

  <!-- N totals below grid -->
  <text x="${GRID_LEFT + CELL_W}" y="${GRID_TOP + 2 * CELL_H + 24}" font-size="12" fill="${PALETTE.textMuted}" text-anchor="middle">Positive predicted: ${tp + fp}</text>
  <text x="${GRID_LEFT + 2 * CELL_W - CELL_W / 2 + CELL_W / 2}" y="${GRID_TOP + 2 * CELL_H + 24}" font-size="12" fill="${PALETTE.textMuted}" text-anchor="middle">Negative predicted: ${tn + fn}</text>
  <text x="${GRID_LEFT - 16}" y="${GRID_TOP + 2 * CELL_H + 24}" font-size="12" fill="${PALETTE.textMuted}">Total: ${total}</text>

  ${missNote}
</svg>`;
}

// ─── Multiclass confusion matrix SVG ─────────────────────────────────────────

/**
 * Render an n×n confusion-matrix heatmap for a multiclass classifier.
 *
 * @param {{
 *   title:     string,
 *   classes:   string[],
 *   matrix:    Record<string, Record<string, number>>,
 *   perClass:  Record<string, {tp,tn,fp,fn,precision,recall,f1,accuracy}>,
 *   macroAvg:  {precision, recall, f1},
 *   accuracy:  number,
 *   n:         number
 * }} data
 */
function multiclassMatrixSVG(data) {
  const { title, classes, matrix, perClass, macroAvg, accuracy, n } = data;
  const nClass  = classes.length;
  const CELL    = 130;
  const LEFT    = 130;   // space for row labels
  const TOP     = 130;   // space for col labels + header
  const W       = LEFT + nClass * CELL + 320;  // 320 for metrics panel
  const GRID_H  = TOP  + nClass * CELL;
  const METRICS_TOP = TOP;
  const H = GRID_H + 120;  // space for macro row + footer

  // Collect all values to determine colour scale
  const allVals = classes.flatMap((a) => classes.map((p) => matrix[a][p]));
  const maxDiag = Math.max(...classes.map((c) => matrix[c][c]), 1);

  function cellColor(actual, predicted, value) {
    if (actual === predicted) {
      // Diagonal: green scale
      return lerpHex("#c6f0d8", PALETTE.cellHit, value / maxDiag);
    }
    if (value === 0) return PALETTE.cellZero;
    const maxOff = Math.max(...allVals.filter((_, i) => {
      const a = classes[Math.floor(i / nClass)];
      const p = classes[i % nClass];
      return a !== p;
    }), 1);
    return lerpHex("#f5b8b2", PALETTE.cellMiss, value / maxOff);
  }

  function cellTextColor(actual, predicted, value) {
    if (actual === predicted && value / maxDiag > 0.5) return PALETTE.textLight;
    if (actual !== predicted && value > 0)             return PALETTE.textLight;
    return PALETTE.textDark;
  }

  const pct = (v) => `${(v * 100).toFixed(1)}%`;
  const MX  = LEFT + nClass * CELL + 30;

  // Per-class metrics rows
  const metricRows = classes.map((cls, i) => {
    const m = perClass[cls];
    const y = METRICS_TOP + i * 72;
    const barW = 110;
    const bars = [
      { label: "Prec", value: m.precision, color: PALETTE.accent },
      { label: "Rec",  value: m.recall,    color: "#7c3aed" },
      { label: "F1",   value: m.f1,        color: "#d97706" },
    ].map((b, bi) => {
      const bx = MX + bi * (barW + 10);
      return `
        <text x="${bx}" y="${y + 12}" font-size="10" fill="${PALETTE.textMuted}">${b.label}</text>
        <rect x="${bx}" y="${y + 16}" width="${barW}" height="8" rx="4" fill="${PALETTE.borderColor}"/>
        <rect x="${bx}" y="${y + 16}" width="${Math.round(b.value * barW)}" height="8" rx="4" fill="${b.color}"/>
        <text x="${bx + barW + 4}" y="${y + 23}" font-size="10" font-weight="700" fill="${PALETTE.textDark}">${pct(b.value)}</text>
      `;
    }).join("");

    const classLabel = cls.charAt(0).toUpperCase() + cls.slice(1);
    return `
      <rect x="${MX - 4}" y="${y - 6}" width="360" height="64" rx="6" fill="#f7fafc" stroke="${PALETTE.borderColor}" stroke-width="1"/>
      <text x="${MX + 2}" y="${y + 8}" font-size="13" font-weight="700" fill="${PALETTE.textDark}">${esc(classLabel)}</text>
      <text x="${MX + 2}" y="${y + 24}" font-size="11" fill="${PALETTE.textMuted}">TP=${m.tp}  TN=${m.tn}  FP=${m.fp}  FN=${m.fn}</text>
      ${bars}
    `;
  }).join("");

  const macroY = METRICS_TOP + classes.length * 72 + 10;

  return `<?xml version="1.0" encoding="utf-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="font-family:Inter,Helvetica,Arial,sans-serif">
  <rect width="${W}" height="${H}" fill="${PALETTE.bg}" rx="12"/>

  <!-- Header -->
  <rect x="0" y="0" width="${W}" height="64" rx="12" fill="${PALETTE.headerBg}"/>
  <rect x="0" y="52" width="${W}" height="12" fill="${PALETTE.headerBg}"/>
  <text x="36" y="40" font-size="20" font-weight="700" fill="${PALETTE.headerText}">${esc(title)}</text>
  <text x="${W - 36}" y="40" font-size="13" fill="#a0aec0" text-anchor="end">n = ${n} test cases  |  Overall accuracy: ${pct(accuracy)}</text>

  <!-- Column headers ("Predicted") -->
  <text x="${LEFT + nClass * CELL / 2}" y="80" font-size="13" font-weight="600" fill="${PALETTE.textMuted}" text-anchor="middle">← Predicted →</text>
  ${classes.map((cls, ci) => `
    <text x="${LEFT + ci * CELL + CELL / 2}" y="108" font-size="13" font-weight="700" fill="${PALETTE.axisLabel}" text-anchor="middle">${esc(cls)}</text>
  `).join("")}

  <!-- Row headers ("Actual") -->
  <text transform="rotate(-90) translate(-${TOP + nClass * CELL / 2}, 24)" font-size="13" font-weight="600" fill="${PALETTE.textMuted}" text-anchor="middle">← Actual →</text>
  ${classes.map((cls, ri) => `
    <text x="${LEFT - 12}" y="${TOP + ri * CELL + CELL / 2 + 5}" font-size="13" font-weight="700" fill="${PALETTE.axisLabel}" text-anchor="end">${esc(cls)}</text>
  `).join("")}

  <!-- Matrix cells -->
  ${classes.map((actual, ri) =>
    classes.map((pred, ci) => {
      const value = matrix[actual][pred];
      const x     = LEFT + ci * CELL;
      const y     = TOP  + ri * CELL;
      const bg    = cellColor(actual, pred, value);
      const fg    = cellTextColor(actual, pred, value);
      const isDiag = actual === pred;
      return `
        <rect x="${x + 2}" y="${y + 2}" width="${CELL - 4}" height="${CELL - 4}" rx="10" fill="${bg}" stroke="${PALETTE.borderColor}" stroke-width="1"/>
        <text x="${x + CELL / 2}" y="${y + CELL / 2 - 4}" font-size="38" font-weight="800" fill="${fg}" text-anchor="middle" dominant-baseline="middle">${value}</text>
        ${isDiag ? `<text x="${x + CELL / 2}" y="${y + CELL / 2 + 26}" font-size="10" fill="${fg}" text-anchor="middle" opacity="0.8">correct</text>` : ""}
      `;
    }).join("")
  ).join("")}

  <!-- Per-class metrics panel -->
  <text x="${MX}" y="${METRICS_TOP - 14}" font-size="14" font-weight="700" fill="${PALETTE.textDark}">Per-class Metrics (One-vs-Rest)</text>
  ${metricRows}

  <!-- Macro averages -->
  <rect x="${MX - 4}" y="${macroY}" width="360" height="50" rx="6" fill="#ebf4ff" stroke="${PALETTE.accent}" stroke-width="1.5"/>
  <text x="${MX + 6}" y="${macroY + 16}" font-size="12" font-weight="700" fill="${PALETTE.accent}">Macro Average</text>
  <text x="${MX + 6}" y="${macroY + 34}" font-size="12" fill="${PALETTE.textDark}">Precision: ${pct(macroAvg.precision)}   Recall: ${pct(macroAvg.recall)}   F1: ${macroAvg.f1.toFixed(3)}</text>

  <!-- Legend -->
  <rect x="36" y="${H - 56}" width="14" height="14" rx="3" fill="${PALETTE.cellHit}"/>
  <text x="56" y="${H - 44}" font-size="11" fill="${PALETTE.textMuted}">Correct (diagonal)</text>
  <rect x="180" y="${H - 56}" width="14" height="14" rx="3" fill="${PALETTE.cellMiss}"/>
  <text x="200" y="${H - 44}" font-size="11" fill="${PALETTE.textMuted}">Misclassified (off-diagonal)</text>
  <rect x="370" y="${H - 56}" width="14" height="14" rx="3" fill="${PALETTE.cellZero}"/>
  <text x="390" y="${H - 44}" font-size="11" fill="${PALETTE.textMuted}">Zero (no errors)</text>
</svg>`;
}

// ─── SVG → PNG rasteriser ─────────────────────────────────────────────────────

async function svgToPng(svgStr, outPath, scale = 2) {
  const buf = Buffer.from(svgStr, "utf8");
  await sharp(buf, { density: 96 * scale })
    .resize({ width: undefined, height: undefined })
    .png({ compressionLevel: 9 })
    .toFile(outPath);
  const stat = (await import("node:fs")).statSync(outPath);
  console.log(`  ✓  ${path.relative(ROOT, outPath)}  (${(stat.size / 1024).toFixed(1)} KB)`);
  return outPath;
}

// ─── Per-classifier PNG generation ───────────────────────────────────────────

const pngPaths = {};

async function generatePNGs() {
  const cls = report.classifiers;

  // 1. classifyMemoryType — multiclass
  const cmt = cls.classifyMemoryType;
  const cmtSVG = multiclassMatrixSVG({
    title:    "Classifier 1 — classifyMemoryType",
    classes:  cmt.classes,
    matrix:   cmt.matrix,
    perClass: cmt.perClass,
    macroAvg: cmt.macroAvg,
    accuracy: cmt.accuracy,
    n:        cmt.n,
  });
  pngPaths.classifyMemoryType = path.join(OUT_DIR, "cm-classifyMemoryType.png");
  await svgToPng(cmtSVG, pngPaths.classifyMemoryType);

  // Binary classifiers
  const binaries = [
    { key: "isSmallTalk",         num: 2, title: "Classifier 2 — isSmallTalk"         },
    { key: "hasLowSignalContent", num: 3, title: "Classifier 3 — hasLowSignalContent"  },
    { key: "shouldStoreMemory",   num: 4, title: "Classifier 4 — shouldStoreMemory"    },
    { key: "isDuplicate",         num: 5, title: "Classifier 5 — isDuplicate"          },
  ];

  for (const bin of binaries) {
    const d = cls[bin.key];
    const svg = binaryMatrixSVG({
      title:              bin.title,
      tp: d.tp, tn: d.tn, fp: d.fp, fn: d.fn,
      accuracy:           d.accuracy,
      precision:          d.precision,
      recall:             d.recall,
      f1:                 d.f1,
      n:                  d.n,
      misclassifiedCases: d.misclassifiedCases,
    });
    pngPaths[bin.key] = path.join(OUT_DIR, `cm-${bin.key}.png`);
    await svgToPng(svg, pngPaths[bin.key]);
  }
}

// ─── Combined HTML report ─────────────────────────────────────────────────────

async function generateHTMLReport() {
  // Embed each PNG as base64 data-URL so the HTML is fully self-contained
  const { readFileSync } = await import("node:fs");
  function imgTag(pngPath, alt) {
    const b64 = readFileSync(pngPath).toString("base64");
    return `<img src="data:image/png;base64,${b64}" alt="${alt}" style="max-width:100%;height:auto;border-radius:10px;box-shadow:0 4px 24px rgba(0,0,0,0.10);">`;
  }

  const cls = report.classifiers;
  const pct = (v) => `${(v * 100).toFixed(1)}%`;
  const fmt  = (v) => (typeof v === "number" ? (v === 1 ? "1.000" : v.toFixed(3)) : v);

  // Summary table rows
  const summaryRows = [
    { name: "classifyMemoryType",   n: cls.classifyMemoryType.n,   accuracy: cls.classifyMemoryType.accuracy,   precision: cls.classifyMemoryType.macroAvg.precision, recall: cls.classifyMemoryType.macroAvg.recall, f1: cls.classifyMemoryType.macroAvg.f1,   tp: "–", tn: "–", fp: "–", fn: "–" },
    { name: "isSmallTalk",          n: cls.isSmallTalk.n,          accuracy: cls.isSmallTalk.accuracy,          precision: cls.isSmallTalk.precision,                 recall: cls.isSmallTalk.recall,                f1: cls.isSmallTalk.f1,                   tp: cls.isSmallTalk.tp, tn: cls.isSmallTalk.tn, fp: cls.isSmallTalk.fp, fn: cls.isSmallTalk.fn },
    { name: "hasLowSignalContent",  n: cls.hasLowSignalContent.n,  accuracy: cls.hasLowSignalContent.accuracy,  precision: cls.hasLowSignalContent.precision,         recall: cls.hasLowSignalContent.recall,        f1: cls.hasLowSignalContent.f1,           tp: cls.hasLowSignalContent.tp, tn: cls.hasLowSignalContent.tn, fp: cls.hasLowSignalContent.fp, fn: cls.hasLowSignalContent.fn },
    { name: "shouldStoreMemory",    n: cls.shouldStoreMemory.n,    accuracy: cls.shouldStoreMemory.accuracy,    precision: cls.shouldStoreMemory.precision,           recall: cls.shouldStoreMemory.recall,          f1: cls.shouldStoreMemory.f1,             tp: cls.shouldStoreMemory.tp, tn: cls.shouldStoreMemory.tn, fp: cls.shouldStoreMemory.fp, fn: cls.shouldStoreMemory.fn },
    { name: "isDuplicate",          n: cls.isDuplicate.n,          accuracy: cls.isDuplicate.accuracy,          precision: cls.isDuplicate.precision,                 recall: cls.isDuplicate.recall,                f1: cls.isDuplicate.f1,                   tp: cls.isDuplicate.tp, tn: cls.isDuplicate.tn, fp: cls.isDuplicate.fp, fn: cls.isDuplicate.fn },
  ];

  function scoreCell(val) {
    const v = typeof val === "number" ? val : null;
    if (v === null) return `<td class="num muted">–</td>`;
    const cls_ = v >= 0.999 ? "perfect" : v >= 0.95 ? "good" : v >= 0.8 ? "ok" : "warn";
    return `<td class="num ${cls_}">${pct(v)}</td>`;
  }
  function intCell(val) {
    if (val === "–") return `<td class="num muted">–</td>`;
    return `<td class="num">${val}</td>`;
  }
  function fnCell(val) {
    if (val === "–") return `<td class="num muted">–</td>`;
    return `<td class="num ${val > 0 ? "warn-cell" : ""}">${val}</td>`;
  }

  const tableRows = summaryRows.map(r => `
    <tr>
      <td class="name"><code>${r.name}</code></td>
      ${intCell(r.n)}
      ${scoreCell(r.accuracy)}
      ${scoreCell(r.precision)}
      ${scoreCell(r.recall)}
      ${scoreCell(r.f1)}
      ${intCell(r.tp)}
      ${intCell(r.tn)}
      ${intCell(r.fp)}
      ${fnCell(typeof r.fn === "number" ? r.fn : "–")}
    </tr>`).join("");

  const fnCase = cls.isSmallTalk.misclassifiedCases[0];

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Neura AI — Classifier Evaluation Report</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;900&display=swap');

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg:         #f0f4f8;
    --card:       #ffffff;
    --border:     #e2e8f0;
    --text:       #1a202c;
    --muted:      #718096;
    --accent:     #3182ce;
    --green:      #1a7a4a;
    --red:        #c0392b;
    --warn-bg:    #fff3cd;
    --warn-border:#f59e0b;
    --warn-text:  #92400e;
  }

  body {
    font-family: 'Inter', Helvetica, Arial, sans-serif;
    background: var(--bg);
    color: var(--text);
    font-size: 15px;
    line-height: 1.6;
  }

  /* ── Cover ── */
  .cover {
    background: linear-gradient(135deg, #1a202c 0%, #2d3748 50%, #1a365d 100%);
    color: #fff;
    padding: 72px 60px 60px;
    position: relative;
    overflow: hidden;
  }
  .cover::after {
    content: '';
    position: absolute;
    right: -80px; top: -80px;
    width: 420px; height: 420px;
    border-radius: 50%;
    background: rgba(255,255,255,0.04);
  }
  .cover .badge {
    display: inline-block;
    background: rgba(255,255,255,0.12);
    border: 1px solid rgba(255,255,255,0.2);
    border-radius: 20px;
    padding: 4px 14px;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #90cdf4;
    margin-bottom: 22px;
  }
  .cover h1 {
    font-size: 42px;
    font-weight: 900;
    line-height: 1.15;
    margin-bottom: 14px;
  }
  .cover h1 span { color: #63b3ed; }
  .cover .subtitle {
    font-size: 18px;
    color: #a0aec0;
    margin-bottom: 36px;
    max-width: 580px;
  }
  .cover .meta-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 16px;
    max-width: 780px;
  }
  .cover .meta-card {
    background: rgba(255,255,255,0.07);
    border: 1px solid rgba(255,255,255,0.12);
    border-radius: 10px;
    padding: 14px 18px;
  }
  .cover .meta-card .val {
    font-size: 28px;
    font-weight: 800;
    color: #fff;
    line-height: 1;
    margin-bottom: 4px;
  }
  .cover .meta-card .lbl {
    font-size: 11px;
    color: #a0aec0;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  /* ── Layout ── */
  .container { max-width: 1140px; margin: 0 auto; padding: 0 36px 72px; }

  /* ── Section ── */
  .section { margin-top: 56px; }
  .section-title {
    font-size: 24px;
    font-weight: 800;
    color: var(--text);
    margin-bottom: 6px;
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .section-title .num {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px; height: 32px;
    border-radius: 50%;
    background: var(--accent);
    color: #fff;
    font-size: 14px;
    font-weight: 700;
    flex-shrink: 0;
  }
  .section-desc {
    font-size: 14px;
    color: var(--muted);
    margin-bottom: 24px;
  }

  /* ── Card ── */
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 32px 36px;
    box-shadow: 0 2px 12px rgba(0,0,0,0.06);
  }

  /* ── Summary table ── */
  .summary-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 14px;
  }
  .summary-table th {
    background: #1a202c;
    color: #e2e8f0;
    padding: 12px 14px;
    font-weight: 600;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    text-align: left;
  }
  .summary-table th:first-child { border-radius: 8px 0 0 0; }
  .summary-table th:last-child  { border-radius: 0 8px 0 0; }
  .summary-table td {
    padding: 13px 14px;
    border-bottom: 1px solid var(--border);
    vertical-align: middle;
  }
  .summary-table tr:last-child td { border-bottom: none; }
  .summary-table tr:hover td { background: #f7fafc; }
  .summary-table td.name code {
    font-family: 'SFMono-Regular', Consolas, monospace;
    font-size: 13px;
    color: var(--accent);
    background: #ebf4ff;
    padding: 2px 8px;
    border-radius: 4px;
  }
  .summary-table td.num { text-align: right; font-weight: 600; }
  .summary-table td.muted { color: var(--muted); font-weight: 400; }
  .summary-table td.perfect { color: var(--green); }
  .summary-table td.good    { color: #2b6cb0; }
  .summary-table td.ok      { color: #d69e2e; }
  .summary-table td.warn    { color: var(--red); }
  .summary-table td.warn-cell { color: var(--red); font-weight: 700; }

  /* ── Heatmap section ── */
  .heatmap-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 36px;
  }
  .heatmap-card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
    box-shadow: 0 2px 12px rgba(0,0,0,0.06);
  }
  .heatmap-card .hm-header {
    background: #1a202c;
    color: #fff;
    padding: 16px 24px;
    font-size: 15px;
    font-weight: 700;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .heatmap-card .hm-header .hm-badge {
    font-size: 12px;
    font-weight: 600;
    padding: 3px 10px;
    border-radius: 12px;
    background: rgba(255,255,255,0.12);
    color: #90cdf4;
  }
  .heatmap-card .hm-body {
    padding: 24px;
    text-align: center;
  }

  /* ── Defect callout ── */
  .defect-card {
    background: var(--warn-bg);
    border: 2px solid var(--warn-border);
    border-radius: 12px;
    padding: 24px 28px;
    margin-top: 32px;
  }
  .defect-card .defect-title {
    font-size: 16px;
    font-weight: 700;
    color: var(--warn-text);
    margin-bottom: 10px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .defect-card .defect-title .icon { font-size: 20px; }
  .defect-card p { font-size: 14px; color: #5f3a00; margin-bottom: 8px; }
  .defect-card code {
    background: rgba(0,0,0,0.06);
    padding: 2px 6px;
    border-radius: 4px;
    font-family: monospace;
    font-size: 13px;
  }
  .defect-card .fix-box {
    background: rgba(0,0,0,0.04);
    border-left: 3px solid var(--warn-border);
    padding: 12px 16px;
    border-radius: 0 6px 6px 0;
    margin-top: 12px;
    font-size: 13px;
    color: #5f3a00;
  }

  /* ── Methodology ── */
  .method-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 16px;
    margin-top: 16px;
  }
  .method-item {
    background: #f7fafc;
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 18px 20px;
  }
  .method-item h4 {
    font-size: 13px;
    font-weight: 700;
    color: var(--accent);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 6px;
  }
  .method-item p { font-size: 13px; color: var(--muted); }

  /* ── Footer ── */
  .footer {
    margin-top: 64px;
    padding: 24px 36px;
    border-top: 1px solid var(--border);
    text-align: center;
    font-size: 12px;
    color: var(--muted);
  }
</style>
</head>
<body>

<!-- ══ COVER ═══════════════════════════════════════════════════════════════════ -->
<div class="cover">
  <div class="badge">Evaluation Report</div>
  <h1>Neura AI<br><span>Classifier Evaluation</span></h1>
  <p class="subtitle">
    Confusion matrix analysis across 5 production classifiers —
    145 hand-labelled test cases, all predictions from live code.
  </p>
  <div class="meta-grid">
    <div class="meta-card"><div class="val">5</div><div class="lbl">Classifiers</div></div>
    <div class="meta-card"><div class="val">145</div><div class="lbl">Test Cases</div></div>
    <div class="meta-card"><div class="val">99.3%</div><div class="lbl">Avg Accuracy</div></div>
    <div class="meta-card"><div class="val">1</div><div class="lbl">Defect Found</div></div>
  </div>
  <p style="margin-top:24px;font-size:12px;color:#718096;">
    Generated ${new Date(report.meta.generatedAt).toUTCString()} &nbsp;·&nbsp; Node ${report.meta.nodeVersion}
  </p>
</div>

<div class="container">

<!-- ══ SECTION 1: SUMMARY TABLE ════════════════════════════════════════════════ -->
<div class="section">
  <div class="section-title"><span class="num">1</span> Overall Results Summary</div>
  <div class="section-desc">
    All metrics are computed from real classifier output — no synthetic or random values.
    <em>classifyMemoryType</em> reports macro-averaged precision/recall/F1 across three classes.
  </div>
  <div class="card" style="padding:0;overflow:hidden;">
    <table class="summary-table">
      <thead>
        <tr>
          <th>Classifier</th>
          <th style="text-align:right">N</th>
          <th style="text-align:right">Accuracy</th>
          <th style="text-align:right">Precision</th>
          <th style="text-align:right">Recall</th>
          <th style="text-align:right">F1</th>
          <th style="text-align:right">TP</th>
          <th style="text-align:right">TN</th>
          <th style="text-align:right">FP</th>
          <th style="text-align:right">FN</th>
        </tr>
      </thead>
      <tbody>${tableRows}</tbody>
    </table>
  </div>
</div>

<!-- ══ SECTION 2: DEFECT ════════════════════════════════════════════════════════ -->
<div class="section">
  <div class="section-title"><span class="num" style="background:#d97706">2</span> Defect Found — isSmallTalk False Negative</div>
  <div class="section-desc">One real classification error was discovered during testing. No production code was modified.</div>
  <div class="defect-card">
    <div class="defect-title"><span class="icon">⚠</span> False Negative: <code>isSmallTalk("how are you")</code> → <code>false</code></div>
    <p><strong>Expected:</strong> <code>true</code> &nbsp;·&nbsp; <strong>Got:</strong> <code>false</code> &nbsp;·&nbsp; <strong>Type:</strong> False Negative (FN=1)</p>
    <p>
      The phrase <code>"how are you"</code> is explicitly listed in <code>SMALL_TALK_WORDS</code> in
      <code>packages/shared/src/index.js</code>. However, the <code>isSmallTalk</code> function
      applies a word-count guard (<code>trimmed.split(/\\s+/).length &lt;= 2</code>) <em>before</em>
      checking the phrase list. Since "how are you" is a 3-word phrase, the guard exits early
      and the phrase check is never reached.
    </p>
    <div class="fix-box">
      <strong>Suggested fix:</strong> Check exact phrase membership in <code>SMALL_TALK_WORDS</code>
      before applying the word-count gate, or expand the gate to
      <code>&lt;= 3</code> words when the content is an exact phrase match.<br>
      <br>
      <code>// Current (buggy): word-count gate before phrase check</code><br>
      <code>// Fix: if (SMALL_TALK_WORDS.includes(trimmed)) return true;</code><br>
      <code>// Then apply the word-count gate for non-phrase inputs</code>
    </div>
  </div>
</div>

<!-- ══ SECTION 3: HEATMAPS ═════════════════════════════════════════════════════ -->
<div class="section">
  <div class="section-title"><span class="num">3</span> Confusion Matrix Heatmaps</div>
  <div class="section-desc">
    Each heatmap is generated from actual test-run data. Green cells = correct predictions.
    Red cells = errors. Counts are absolute (not normalised) so the scale reflects real case volumes.
  </div>
  <div class="heatmap-grid">

    <div class="heatmap-card">
      <div class="hm-header">
        Classifier 1 — classifyMemoryType
        <span class="hm-badge">Multiclass · 3 Labels · n=41</span>
      </div>
      <div class="hm-body">
        ${imgTag(pngPaths.classifyMemoryType, "classifyMemoryType confusion matrix")}
      </div>
    </div>

    <div class="heatmap-card">
      <div class="hm-header">
        Classifier 2 — isSmallTalk
        <span class="hm-badge">Binary · n=30 · ⚠ 1 FN</span>
      </div>
      <div class="hm-body">
        ${imgTag(pngPaths.isSmallTalk, "isSmallTalk confusion matrix")}
      </div>
    </div>

    <div class="heatmap-card">
      <div class="hm-header">
        Classifier 3 — hasLowSignalContent
        <span class="hm-badge">Binary · n=25 · Perfect</span>
      </div>
      <div class="hm-body">
        ${imgTag(pngPaths.hasLowSignalContent, "hasLowSignalContent confusion matrix")}
      </div>
    </div>

    <div class="heatmap-card">
      <div class="hm-header">
        Classifier 4 — shouldStoreMemory
        <span class="hm-badge">Binary · n=29 · Perfect</span>
      </div>
      <div class="hm-body">
        ${imgTag(pngPaths.shouldStoreMemory, "shouldStoreMemory confusion matrix")}
      </div>
    </div>

    <div class="heatmap-card">
      <div class="hm-header">
        Classifier 5 — isDuplicate
        <span class="hm-badge">Binary · n=20 · Perfect</span>
      </div>
      <div class="hm-body">
        ${imgTag(pngPaths.isDuplicate, "isDuplicate confusion matrix")}
      </div>
    </div>

  </div>
</div>

<!-- ══ SECTION 4: METHODOLOGY ══════════════════════════════════════════════════ -->
<div class="section">
  <div class="section-title"><span class="num">4</span> Methodology</div>
  <div class="card">
    <p style="font-size:14px;color:var(--muted);margin-bottom:16px;">${report.meta.methodology}</p>
    <div class="method-grid">
      <div class="method-item">
        <h4>Test Case Design</h4>
        <p>Ground-truth labels were assigned by reading each classifier's source code logic
           (pattern-sets.js, shared/index.js, extractor.js, deduplicationService.js) and
           applying the same conditions a human reviewer would use. No randomisation was used.</p>
      </div>
      <div class="method-item">
        <h4>Execution</h4>
        <p>All predictions are produced by calling the real production functions from
           <code>@neura/core</code> and <code>@neura/shared</code>. The test runner
           (<code>tools/confusion-matrix.js</code>) imports these packages via the
           npm workspace and invokes each function directly.</p>
      </div>
      <div class="method-item">
        <h4>Metrics</h4>
        <p>Binary classifiers: TP, TN, FP, FN, accuracy, precision, recall, F1.
           Multiclass (classifyMemoryType): 3×3 confusion matrix, one-vs-rest per-class
           metrics, and macro-averaged scores.</p>
      </div>
      <div class="method-item">
        <h4>No Production Changes</h4>
        <p>All test and reporting code lives in <code>tools/</code> and <code>reports/</code>.
           No production modules were modified. The identified isSmallTalk defect is documented
           here for tracking — the fix is a separate concern.</p>
      </div>
    </div>
  </div>
</div>

</div><!-- /container -->

<div class="footer">
  Neura AI · Classifier Evaluation Report · Generated ${new Date().toUTCString()}
  · Source data: <code>tools/confusion-matrix-report.json</code>
</div>

</body>
</html>`;

  const htmlPath = path.join(OUT_DIR, "neura-evaluation-report.html");
  writeFileSync(htmlPath, html, "utf8");
  const stat = (await import("node:fs")).statSync(htmlPath);
  console.log(`  ✓  ${path.relative(ROOT, htmlPath)}  (${(stat.size / 1024).toFixed(1)} KB)`);
  return htmlPath;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

console.log("\n  Neura AI — Visual Report Generator\n  " + "─".repeat(40));
console.log(`  Output directory: ${path.relative(ROOT, OUT_DIR)}/\n`);

await generatePNGs();
await generateHTMLReport();

console.log("\n  Done. Open reports/neura-evaluation-report.html in a browser.\n");
