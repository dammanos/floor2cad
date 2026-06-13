/**
 * Vector-PDF fast-path proof of concept.
 *
 * Instead of rasterizing a vector PDF and guessing geometry back from pixels
 * (the current PdfConverter -> CV pipeline), this reads the PDF's own drawing
 * operators and text, and emits a DXF directly.
 *
 * Usage: node scripts/vector-extract.mjs <input.pdf> [pageNumber] [output.dxf]
 */
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
const { getDocument, OPS, Util } = pdfjs;

const dxfMod = await import('@tarikjabiri/dxf');
const { DxfWriter, Colors, point3d } = dxfMod;

const inputPath = process.argv[2];
const pageNumber = Number(process.argv[3] || 1);
const outPath = process.argv[4] || path.join('outputs', 'vector-extract.dxf');

if (!inputPath) {
    console.error('Usage: node scripts/vector-extract.mjs <input.pdf> [page] [out.dxf]');
    process.exit(1);
}

// ── Load PDF ────────────────────────────────────────────────────────────────
const data = new Uint8Array(await fs.readFile(inputPath));
const doc = await getDocument({ data, disableFontFace: true }).promise;
const page = await doc.getPage(pageNumber);
const viewport = page.getViewport({ scale: 1 });
const pageW = viewport.width;
const pageH = viewport.height;

// ── Classify: vector vs raster ────────────────────────────────────────────────
const opList = await page.getOperatorList();
const counts = { paths: 0, images: 0, strokes: 0, fills: 0, text: 0 };
for (const fn of opList.fnArray) {
    if (fn === OPS.constructPath) counts.paths++;
    else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintJpegXObject) counts.images++;
    else if (fn === OPS.stroke || fn === OPS.closeStroke) counts.strokes++;
    else if (fn === OPS.fill || fn === OPS.eoFill || fn === OPS.fillStroke || fn === OPS.eoFillStroke) counts.fills++;
    else if (fn === OPS.showText || fn === OPS.showSpacedText) counts.text++;
}
const isVector = counts.paths > counts.images * 5 && counts.paths > 20;

// ── Walk the operator list, tracking the graphics state (CTM, line width) ─────
// Initialise CTM with the viewport transform so emitted coords are in device
// (viewport) space: y-down, upright, page rotation already applied.
let ctm = viewport.transform.slice();
const stack = [];
let lineWidth = 1;
let pending = []; // segments of the current (not-yet-painted) path, in device space

const segments = []; // committed stroked segments: {x1,y1,x2,y2,w}

const scaleOf = (m) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
const apply = (x, y) => Util.applyTransform([x, y], ctm);

const buildPath = (ops, args) => {
    // Decode constructPath sub-ops into device-space line segments.
    let i = 0;
    let cx = 0; let cy = 0;     // current point (device space)
    let sx = 0; let sy = 0;     // subpath start (for close)
    for (const op of ops) {
        switch (op) {
            case OPS.moveTo: {
                const [x, y] = apply(args[i], args[i + 1]); i += 2;
                cx = sx = x; cy = sy = y;
                break;
            }
            case OPS.lineTo: {
                const [x, y] = apply(args[i], args[i + 1]); i += 2;
                pending.push({ x1: cx, y1: cy, x2: x, y2: y });
                cx = x; cy = y;
                break;
            }
            case OPS.curveTo: {
                // Flatten cubic bezier into a few straight chords.
                const c1 = apply(args[i], args[i + 1]);
                const c2 = apply(args[i + 2], args[i + 3]);
                const e = apply(args[i + 4], args[i + 5]); i += 6;
                flattenCubic(cx, cy, c1[0], c1[1], c2[0], c2[1], e[0], e[1]);
                cx = e[0]; cy = e[1];
                break;
            }
            case OPS.curveTo2: {
                const c2 = apply(args[i], args[i + 1]);
                const e = apply(args[i + 2], args[i + 3]); i += 4;
                flattenCubic(cx, cy, cx, cy, c2[0], c2[1], e[0], e[1]);
                cx = e[0]; cy = e[1];
                break;
            }
            case OPS.curveTo3: {
                const c1 = apply(args[i], args[i + 1]);
                const e = apply(args[i + 2], args[i + 3]); i += 4;
                flattenCubic(cx, cy, c1[0], c1[1], e[0], e[1], e[0], e[1]);
                cx = e[0]; cy = e[1];
                break;
            }
            case OPS.rectangle: {
                const x = args[i]; const y = args[i + 1]; const w = args[i + 2]; const h = args[i + 3]; i += 4;
                const p0 = apply(x, y); const p1 = apply(x + w, y);
                const p2 = apply(x + w, y + h); const p3 = apply(x, y + h);
                pending.push({ x1: p0[0], y1: p0[1], x2: p1[0], y2: p1[1] });
                pending.push({ x1: p1[0], y1: p1[1], x2: p2[0], y2: p2[1] });
                pending.push({ x1: p2[0], y1: p2[1], x2: p3[0], y2: p3[1] });
                pending.push({ x1: p3[0], y1: p3[1], x2: p0[0], y2: p0[1] });
                cx = p0[0]; cy = p0[1]; sx = cx; sy = cy;
                break;
            }
            case OPS.closePath: {
                pending.push({ x1: cx, y1: cy, x2: sx, y2: sy });
                cx = sx; cy = sy;
                break;
            }
            default:
                break;
        }
    }
};

function flattenCubic(x0, y0, x1, y1, x2, y2, x3, y3, steps = 6) {
    let px = x0; let py = y0;
    for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        const mt = 1 - t;
        const a = mt * mt * mt;
        const b = 3 * mt * mt * t;
        const c = 3 * mt * t * t;
        const d = t * t * t;
        const x = a * x0 + b * x1 + c * x2 + d * x3;
        const y = a * y0 + b * y1 + c * y2 + d * y3;
        pending.push({ x1: px, y1: py, x2: x, y2: y });
        px = x; py = y;
    }
}

const commit = () => {
    const w = lineWidth * scaleOf(ctm);
    for (const s of pending) segments.push({ ...s, w });
    pending = [];
};

const fn = opList.fnArray;
const ar = opList.argsArray;
for (let k = 0; k < fn.length; k++) {
    switch (fn[k]) {
        case OPS.save: stack.push(ctm.slice()); break;
        case OPS.restore: if (stack.length) ctm = stack.pop(); break;
        case OPS.transform: ctm = Util.transform(ctm, ar[k]); break;
        case OPS.setLineWidth: lineWidth = ar[k][0]; break;
        case OPS.constructPath: {
            // v4: args = [opsArray, coordsArray, minMax?]
            const [ops, coords] = ar[k];
            buildPath(ops, coords);
            break;
        }
        case OPS.stroke:
        case OPS.closeStroke:
        case OPS.fillStroke:
        case OPS.eoFillStroke:
            commit();
            break;
        case OPS.fill:
        case OPS.eoFill:
        case OPS.endPath:
            pending = []; // discard non-stroked fills/clips for this PoC
            break;
        default:
            break;
    }
}

// ── Text with coordinates ─────────────────────────────────────────────────────
const textContent = await page.getTextContent();
const texts = [];
for (const item of textContent.items) {
    if (!item.str || !item.str.trim()) continue;
    const [x, y] = Util.applyTransform([item.transform[4], item.transform[5]], viewport.transform);
    texts.push({ str: item.str, x, y, height: item.height || 8 });
}

// ── Wall consolidation: segments -> collinear runs -> double-line walls ────────
// Walls in CAD prints are drawn as a *pair* of parallel lines (the wall cavity),
// each broken into many short segments. Recovering them is three steps:
//   1. keep axis-aligned segments and merge collinear/touching ones into runs
//   2. find pairs of parallel runs a wall-thickness apart that overlap in extent
//   3. collapse each pair into a centerline + thickness
const num = (env, d) => (process.env[env] !== undefined ? Number(process.env[env]) : d);
const AXIS_TOL = num('AXIS_TOL', 1.2);   // max deviation to count as horizontal/vertical
const MIN_SEG = num('MIN_SEG', 3);       // ignore sub-segments shorter than this
const JOIN_GAP = num('JOIN_GAP', 12);    // bridge collinear runs across gaps (doors/ticks)
const BUCKET = num('BUCKET', 1.5);       // collinear tolerance across the axis
const MIN_THICK = num('MIN_THICK', 2);   // plausible wall thickness band (pt)
const MAX_THICK = num('MAX_THICK', 16);
const MIN_OVERLAP = num('MIN_OVERLAP', 10); // a wall pair must co-run at least this far (pt)
const SNAP = num('SNAP', 14);            // junction snap distance (pt)

// 1a. classify axis-aligned segments
const horiz = []; // {pos:y, a:xmin, b:xmax}
const vert = [];  // {pos:x, a:ymin, b:ymax}
for (const s of segments) {
    const dx = Math.abs(s.x2 - s.x1); const dy = Math.abs(s.y2 - s.y1);
    if (dy <= AXIS_TOL && dx > MIN_SEG) {
        horiz.push({ pos: (s.y1 + s.y2) / 2, a: Math.min(s.x1, s.x2), b: Math.max(s.x1, s.x2) });
    } else if (dx <= AXIS_TOL && dy > MIN_SEG) {
        vert.push({ pos: (s.x1 + s.x2) / 2, a: Math.min(s.y1, s.y2), b: Math.max(s.y1, s.y2) });
    }
}

// 1b. merge collinear + touching segments into continuous runs
const mergeRuns = (items) => {
    const buckets = new Map();
    for (const it of items) {
        const key = Math.round(it.pos / BUCKET);
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(it);
    }
    const runs = [];
    for (const group of buckets.values()) {
        group.sort((p, q) => p.a - q.a);
        let cur = null;
        let posSum = 0; let posN = 0;
        for (const it of group) {
            if (cur && it.a <= cur.b + JOIN_GAP) {
                cur.b = Math.max(cur.b, it.b);
                posSum += it.pos; posN++;
                cur.pos = posSum / posN;
            } else {
                if (cur) runs.push(cur);
                cur = { pos: it.pos, a: it.a, b: it.b };
                posSum = it.pos; posN = 1;
            }
        }
        if (cur) runs.push(cur);
    }
    return runs;
};
const hRuns = mergeRuns(horiz);
const vRuns = mergeRuns(vert);

// 2 + 3. Length is the wall discriminator: long collinear runs ARE the walls.
// Keep long runs; collapse parallel double-line pairs to a centerline+thickness;
// keep unpaired long runs as single-line walls. (Thickness-pairing alone fails
// here because hatching/tile fill also forms close parallel pairs.)
const MIN_WALL_LEN = num('MIN_WALL_LEN', 40);
const overlap = (r1, r2) => Math.min(r1.b, r2.b) - Math.max(r1.a, r2.a);
const buildWalls = (allRuns, orient) => {
    const runs = allRuns.filter((r) => r.b - r.a >= MIN_WALL_LEN);
    const used = new Array(runs.length).fill(false);
    const walls = [];
    const order = runs.map((_, i) => i).sort((i, j) => (runs[j].b - runs[j].a) - (runs[i].b - runs[i].a));
    for (const i of order) {
        if (used[i]) continue;
        // find nearest parallel partner -> double-line wall
        let best = -1; let bestGap = Infinity;
        for (let j = 0; j < runs.length; j++) {
            if (j === i || used[j]) continue;
            const gap = Math.abs(runs[i].pos - runs[j].pos);
            if (gap < MIN_THICK || gap > MAX_THICK) continue;
            if (overlap(runs[i], runs[j]) < MIN_OVERLAP) continue;
            if (gap < bestGap) { bestGap = gap; best = j; }
        }
        used[i] = true;
        let pos; let a; let b; let thickness;
        if (best >= 0) {
            used[best] = true;
            pos = (runs[i].pos + runs[best].pos) / 2;
            a = Math.max(runs[i].a, runs[best].a); b = Math.min(runs[i].b, runs[best].b);
            thickness = bestGap;
        } else {
            pos = runs[i].pos; a = runs[i].a; b = runs[i].b; thickness = 2; // single-line wall
        }
        walls.push(orient === 'h'
            ? { x1: a, y1: pos, x2: b, y2: pos, thickness, orientation: 'horizontal' }
            : { x1: pos, y1: a, x2: pos, y2: b, thickness, orientation: 'vertical' });
    }
    return walls;
};
let walls = [...buildWalls(hRuns, 'h'), ...buildWalls(vRuns, 'v')];
const beforeFilter = walls.length;
const wlen = (w) => Math.hypot(w.x2 - w.x1, w.y2 - w.y1);
const doubleCount = walls.filter((w) => w.thickness > 2).length;

// Junction snapping: extend each wall's endpoints to meet a crossing
// perpendicular wall within SNAP, so the network closes into rooms.
const snapAxis = (movers, crossers, axis) => {
    for (const w of movers) {
        for (const end of ['1', '2']) {
            const ex = w[`x${end}`]; const ey = w[`y${end}`];
            for (const c of crossers) {
                const cLine = axis === 'h' ? c.x1 : c.y1;           // crosser's fixed coord
                const cMin = axis === 'h' ? Math.min(c.y1, c.y2) : Math.min(c.x1, c.x2);
                const cMax = axis === 'h' ? Math.max(c.y1, c.y2) : Math.max(c.x1, c.x2);
                if (axis === 'h') {
                    if (Math.abs(ex - cLine) <= SNAP && ey >= cMin - SNAP && ey <= cMax + SNAP) w[`x${end}`] = cLine;
                } else {
                    if (Math.abs(ey - cLine) <= SNAP && ex >= cMin - SNAP && ex <= cMax + SNAP) w[`y${end}`] = cLine;
                }
            }
        }
    }
};
const hWalls = walls.filter((w) => w.orientation === 'horizontal');
const vWalls = walls.filter((w) => w.orientation === 'vertical');
snapAxis(hWalls, vWalls, 'h'); // extend horizontal wall ends to meet verticals
snapAxis(vWalls, hWalls, 'v');

const wallLen = walls.reduce((s, w) => s + Math.hypot(w.x2 - w.x1, w.y2 - w.y1), 0);
const thicknesses = walls.map((w) => w.thickness).sort((p, q) => p - q);
const medThick = thicknesses.length ? thicknesses[Math.floor(thicknesses.length / 2)] : 0;

// ── Emit DXF (reusing the project's DXF library) ──────────────────────────────
const out = new DxfWriter();
out.addLayer('VECTOR', Colors.White);
out.addLayer('WALLS', Colors.Yellow);
out.addLayer('TEXT', Colors.Cyan);
const flip = (y) => pageH - y; // viewport y-down -> DXF y-up

for (const s of segments) {
    out.addLine(point3d(s.x1, flip(s.y1)), point3d(s.x2, flip(s.y2)), { layerName: 'VECTOR' });
}
for (const w of walls) {
    out.addLine(point3d(w.x1, flip(w.y1)), point3d(w.x2, flip(w.y2)), { layerName: 'WALLS' });
}
for (const t of texts) {
    out.addText(point3d(t.x, flip(t.y)), Math.max(2, t.height), t.str, { layerName: 'TEXT' });
}

await fs.mkdir(path.dirname(outPath), { recursive: true });
await fs.writeFile(outPath, out.stringify());

// ── Visual preview (SVG -> PNG via sharp) so the result can be eyeballed ───────
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const svgParts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${pageW}" height="${pageH}" viewBox="0 0 ${pageW} ${pageH}"><rect width="100%" height="100%" fill="white"/>`];
for (const s of segments) {
    svgParts.push(`<line x1="${s.x1.toFixed(1)}" y1="${s.y1.toFixed(1)}" x2="${s.x2.toFixed(1)}" y2="${s.y2.toFixed(1)}" stroke="#999" stroke-width="0.5"/>`);
}
if (process.env.SHOW_RUNS) {
    const longRuns = [
        ...hRuns.filter((r) => r.b - r.a > 40).map((r) => ({ x1: r.a, y1: r.pos, x2: r.b, y2: r.pos })),
        ...vRuns.filter((r) => r.b - r.a > 40).map((r) => ({ x1: r.pos, y1: r.a, x2: r.pos, y2: r.b })),
    ];
    for (const r of longRuns) {
        svgParts.push(`<line x1="${r.x1.toFixed(1)}" y1="${r.y1.toFixed(1)}" x2="${r.x2.toFixed(1)}" y2="${r.y2.toFixed(1)}" stroke="green" stroke-width="1.2"/>`);
    }
}
for (const w of walls) {
    svgParts.push(`<line x1="${w.x1.toFixed(1)}" y1="${w.y1.toFixed(1)}" x2="${w.x2.toFixed(1)}" y2="${w.y2.toFixed(1)}" stroke="red" stroke-width="${Math.max(2.5, w.thickness).toFixed(1)}" stroke-opacity="0.85" stroke-linecap="round"/>`);
}
for (const t of texts) {
    svgParts.push(`<text x="${t.x.toFixed(1)}" y="${t.y.toFixed(1)}" font-size="${Math.max(6, t.height)}" fill="blue">${esc(t.str)}</text>`);
}
svgParts.push('</svg>');
const svgPath = outPath.replace(/\.dxf$/, '.svg');
const pngPath = outPath.replace(/\.dxf$/, '.png');
await fs.writeFile(svgPath, svgParts.join('\n'));
try {
    const sharp = (await import('sharp')).default;
    await sharp(Buffer.from(svgParts.join('\n'))).png().toFile(pngPath);
} catch (e) {
    console.warn('preview PNG skipped:', e.message);
}

// ── Report ────────────────────────────────────────────────────────────────────
console.log('── Vector-PDF extraction ──────────────────────────────');
console.log(`file            : ${path.basename(inputPath)}  page ${pageNumber}/${doc.numPages}`);
console.log(`page size       : ${pageW.toFixed(0)} x ${pageH.toFixed(0)} pt`);
console.log(`classifier      : ${isVector ? 'VECTOR (fast path)' : 'RASTER (fall back to CV)'}`);
console.log(`  constructPath : ${counts.paths}   images: ${counts.images}   strokes: ${counts.strokes}   fills: ${counts.fills}`);
console.log(`stroked segments: ${segments.length}`);
console.log(`collinear runs  : ${hRuns.length} horizontal + ${vRuns.length} vertical`);
console.log(`walls recovered : ${walls.length}  (${doubleCount} double-line + ${walls.length - doubleCount} single-line)`);
console.log(`  median thick  : ${medThick.toFixed(1)} pt   total wall length: ${wallLen.toFixed(0)} pt`);
console.log(`text items      : ${texts.length}  (exact Unicode + coords; e.g. "${texts.find((t) => /[Α-Ωα-ω]/.test(t.str))?.str ?? texts[0]?.str ?? ''}")`);
console.log(`DXF written     : ${outPath}`);
