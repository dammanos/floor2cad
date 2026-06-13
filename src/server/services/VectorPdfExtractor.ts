import { promises as fs } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { ExtractionMetrics, FloorPlan, TextElement, Wall } from '../../shared/types';

// pdfjs-dist is ESM-only; this server is compiled to CommonJS, where TypeScript
// would rewrite `import()` into `require()` and fail to load an ES module. The
// indirect `Function` import keeps a genuine dynamic import at runtime.
const dynamicImport = new Function('specifier', 'return import(specifier)') as (s: string) => Promise<any>;
let pdfjsPromise: Promise<any> | undefined;
const loadPdfjs = () => (pdfjsPromise ??= dynamicImport('pdfjs-dist/legacy/build/pdf.mjs'));

interface Segment { x1: number; y1: number; x2: number; y2: number; w: number; }
interface Run { pos: number; a: number; b: number; }
interface WallLine { x1: number; y1: number; x2: number; y2: number; thickness: number; orientation: 'horizontal' | 'vertical'; }

export interface VectorExtraction {
    isVector: boolean;
    floorPlan?: FloorPlan;
    stats: {
        paths: number;
        images: number;
        segments: number;
        walls: number;
        textItems: number;
        scale?: number;
        unit?: string;
        scaleConfidence?: number;
    };
}

// Tuned on real printed-from-CAD plans. Length is the wall discriminator:
// long collinear runs are walls; close parallel runs collapse to a centerline.
const CFG = {
    AXIS_TOL: 1.2,
    MIN_SEG: 3,
    JOIN_GAP: 20,
    BUCKET: 1.5,
    MIN_THICK: 2,
    MAX_THICK: 16,
    MIN_OVERLAP: 8,
    MIN_WALL_LEN: 40,
    SNAP: 14,
};

export class VectorPdfExtractor {
    /**
     * Read a PDF's own vector geometry + text instead of rasterizing it.
     * Returns isVector=false (with no floorPlan) for scanned/image PDFs so the
     * caller can fall back to the raster CV pipeline.
     */
    async process(pdfPath: string, imagePathForRecord = pdfPath): Promise<VectorExtraction> {
        const pdfjs = await loadPdfjs();
        const { getDocument, OPS, Util } = pdfjs;

        const data = new Uint8Array(await fs.readFile(pdfPath));
        const doc = await getDocument({ data, disableFontFace: true }).promise;
        const page = await doc.getPage(1);
        const viewport = page.getViewport({ scale: 1 });
        const pageW = viewport.width;
        const pageH = viewport.height;
        const opList = await page.getOperatorList();

        // ── Classify vector vs raster ──────────────────────────────────────
        let pathOps = 0;
        let imageOps = 0;
        for (const fn of opList.fnArray) {
            if (fn === OPS.constructPath) pathOps++;
            else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintJpegXObject) imageOps++;
        }
        const isVector = pathOps > imageOps * 5 && pathOps > 20;
        if (!isVector) {
            return { isVector: false, stats: { paths: pathOps, images: imageOps, segments: 0, walls: 0, textItems: 0 } };
        }

        const segments = this.extractSegments(opList, viewport, OPS, Util);
        const walls = this.buildWalls(segments);
        const textElements = await this.extractText(page, viewport, Util);

        const floorPlan = this.assemble(imagePathForRecord, pageW, pageH, walls, textElements);
        return {
            isVector: true,
            floorPlan,
            stats: {
                paths: pathOps, images: imageOps, segments: segments.length, walls: walls.length, textItems: textElements.length,
                scale: floorPlan.scale, unit: floorPlan.unit, scaleConfidence: floorPlan.metrics.scaleConfidence,
            },
        };
    }

    // ── Walk operator list, tracking CTM/line-width, emit stroked segments ──
    private extractSegments(opList: any, viewport: any, OPS: any, Util: any): Segment[] {
        let ctm: number[] = viewport.transform.slice();
        const stack: number[][] = [];
        let lineWidth = 1;
        let pending: Segment[] = [];
        const segments: Segment[] = [];

        const scaleOf = (m: number[]) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
        const apply = (x: number, y: number): number[] => Util.applyTransform([x, y], ctm);

        const flattenCubic = (x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, steps = 6) => {
            let px = x0; let py = y0;
            for (let s = 1; s <= steps; s++) {
                const t = s / steps; const mt = 1 - t;
                const a = mt * mt * mt; const b = 3 * mt * mt * t; const c = 3 * mt * t * t; const d = t * t * t;
                const x = a * x0 + b * x1 + c * x2 + d * x3;
                const y = a * y0 + b * y1 + c * y2 + d * y3;
                pending.push({ x1: px, y1: py, x2: x, y2: y, w: 0 });
                px = x; py = y;
            }
        };

        const buildPath = (ops: number[], args: number[]) => {
            let i = 0; let cx = 0; let cy = 0; let sx = 0; let sy = 0;
            for (const op of ops) {
                if (op === OPS.moveTo) {
                    const p = apply(args[i], args[i + 1]); i += 2; cx = sx = p[0]; cy = sy = p[1];
                } else if (op === OPS.lineTo) {
                    const p = apply(args[i], args[i + 1]); i += 2;
                    pending.push({ x1: cx, y1: cy, x2: p[0], y2: p[1], w: 0 }); cx = p[0]; cy = p[1];
                } else if (op === OPS.curveTo) {
                    const c1 = apply(args[i], args[i + 1]); const c2 = apply(args[i + 2], args[i + 3]); const e = apply(args[i + 4], args[i + 5]); i += 6;
                    flattenCubic(cx, cy, c1[0], c1[1], c2[0], c2[1], e[0], e[1]); cx = e[0]; cy = e[1];
                } else if (op === OPS.curveTo2) {
                    const c2 = apply(args[i], args[i + 1]); const e = apply(args[i + 2], args[i + 3]); i += 4;
                    flattenCubic(cx, cy, cx, cy, c2[0], c2[1], e[0], e[1]); cx = e[0]; cy = e[1];
                } else if (op === OPS.curveTo3) {
                    const c1 = apply(args[i], args[i + 1]); const e = apply(args[i + 2], args[i + 3]); i += 4;
                    flattenCubic(cx, cy, c1[0], c1[1], e[0], e[1], e[0], e[1]); cx = e[0]; cy = e[1];
                } else if (op === OPS.rectangle) {
                    const x = args[i]; const y = args[i + 1]; const w = args[i + 2]; const h = args[i + 3]; i += 4;
                    const p0 = apply(x, y); const p1 = apply(x + w, y); const p2 = apply(x + w, y + h); const p3 = apply(x, y + h);
                    pending.push({ x1: p0[0], y1: p0[1], x2: p1[0], y2: p1[1], w: 0 });
                    pending.push({ x1: p1[0], y1: p1[1], x2: p2[0], y2: p2[1], w: 0 });
                    pending.push({ x1: p2[0], y1: p2[1], x2: p3[0], y2: p3[1], w: 0 });
                    pending.push({ x1: p3[0], y1: p3[1], x2: p0[0], y2: p0[1], w: 0 });
                    cx = sx = p0[0]; cy = sy = p0[1];
                } else if (op === OPS.closePath) {
                    pending.push({ x1: cx, y1: cy, x2: sx, y2: sy, w: 0 }); cx = sx; cy = sy;
                }
            }
        };

        const commit = () => {
            const w = lineWidth * scaleOf(ctm);
            for (const s of pending) { s.w = w; segments.push(s); }
            pending = [];
        };

        const fn = opList.fnArray; const ar = opList.argsArray;
        for (let k = 0; k < fn.length; k++) {
            const op = fn[k];
            if (op === OPS.save) stack.push(ctm.slice());
            else if (op === OPS.restore) { if (stack.length) ctm = stack.pop() as number[]; }
            else if (op === OPS.transform) ctm = Util.transform(ctm, ar[k]);
            else if (op === OPS.setLineWidth) lineWidth = ar[k][0];
            else if (op === OPS.constructPath) buildPath(ar[k][0], ar[k][1]);
            else if (op === OPS.stroke || op === OPS.closeStroke || op === OPS.fillStroke || op === OPS.eoFillStroke) commit();
            else if (op === OPS.fill || op === OPS.eoFill || op === OPS.endPath) pending = [];
        }
        return segments;
    }

    private mergeRuns(items: Run[]): Run[] {
        const buckets = new Map<number, Run[]>();
        for (const it of items) {
            const key = Math.round(it.pos / CFG.BUCKET);
            if (!buckets.has(key)) buckets.set(key, []);
            (buckets.get(key) as Run[]).push(it);
        }
        const runs: Run[] = [];
        for (const group of buckets.values()) {
            group.sort((p, q) => p.a - q.a);
            let cur: Run | null = null; let posSum = 0; let posN = 0;
            for (const it of group) {
                if (cur && it.a <= cur.b + CFG.JOIN_GAP) {
                    cur.b = Math.max(cur.b, it.b); posSum += it.pos; posN++; cur.pos = posSum / posN;
                } else {
                    if (cur) runs.push(cur);
                    cur = { pos: it.pos, a: it.a, b: it.b }; posSum = it.pos; posN = 1;
                }
            }
            if (cur) runs.push(cur);
        }
        return runs;
    }

    private buildWalls(segments: Segment[]): WallLine[] {
        const horiz: Run[] = []; const vert: Run[] = [];
        for (const s of segments) {
            const dx = Math.abs(s.x2 - s.x1); const dy = Math.abs(s.y2 - s.y1);
            if (dy <= CFG.AXIS_TOL && dx > CFG.MIN_SEG) horiz.push({ pos: (s.y1 + s.y2) / 2, a: Math.min(s.x1, s.x2), b: Math.max(s.x1, s.x2) });
            else if (dx <= CFG.AXIS_TOL && dy > CFG.MIN_SEG) vert.push({ pos: (s.x1 + s.x2) / 2, a: Math.min(s.y1, s.y2), b: Math.max(s.y1, s.y2) });
        }
        const hRuns = this.mergeRuns(horiz);
        const vRuns = this.mergeRuns(vert);

        const overlap = (r1: Run, r2: Run) => Math.min(r1.b, r2.b) - Math.max(r1.a, r2.a);
        const build = (allRuns: Run[], orient: 'h' | 'v'): WallLine[] => {
            const runs = allRuns.filter((r) => r.b - r.a >= CFG.MIN_WALL_LEN);
            const used = new Array(runs.length).fill(false);
            const out: WallLine[] = [];
            const order = runs.map((_, i) => i).sort((i, j) => (runs[j].b - runs[j].a) - (runs[i].b - runs[i].a));
            for (const i of order) {
                if (used[i]) continue;
                let best = -1; let bestGap = Infinity;
                for (let j = 0; j < runs.length; j++) {
                    if (j === i || used[j]) continue;
                    const gap = Math.abs(runs[i].pos - runs[j].pos);
                    if (gap < CFG.MIN_THICK || gap > CFG.MAX_THICK) continue;
                    if (overlap(runs[i], runs[j]) < CFG.MIN_OVERLAP) continue;
                    if (gap < bestGap) { bestGap = gap; best = j; }
                }
                used[i] = true;
                let pos: number; let a: number; let b: number; let thickness: number;
                if (best >= 0) {
                    used[best] = true;
                    pos = (runs[i].pos + runs[best].pos) / 2;
                    a = Math.max(runs[i].a, runs[best].a); b = Math.min(runs[i].b, runs[best].b); thickness = bestGap;
                } else { pos = runs[i].pos; a = runs[i].a; b = runs[i].b; thickness = 2; }
                out.push(orient === 'h'
                    ? { x1: a, y1: pos, x2: b, y2: pos, thickness, orientation: 'horizontal' }
                    : { x1: pos, y1: a, x2: pos, y2: b, thickness, orientation: 'vertical' });
            }
            return out;
        };
        const walls = [...build(hRuns, 'h'), ...build(vRuns, 'v')];

        // Junction snapping: extend wall ends to meet crossing perpendicular walls.
        const hWalls = walls.filter((w) => w.orientation === 'horizontal');
        const vWalls = walls.filter((w) => w.orientation === 'vertical');
        this.snap(hWalls, vWalls, 'h');
        this.snap(vWalls, hWalls, 'v');
        return walls;
    }

    private snap(movers: WallLine[], crossers: WallLine[], axis: 'h' | 'v'): void {
        for (const w of movers) {
            for (const end of ['1', '2'] as const) {
                const ex = (w as any)[`x${end}`]; const ey = (w as any)[`y${end}`];
                for (const c of crossers) {
                    const cLine = axis === 'h' ? c.x1 : c.y1;
                    const cMin = axis === 'h' ? Math.min(c.y1, c.y2) : Math.min(c.x1, c.x2);
                    const cMax = axis === 'h' ? Math.max(c.y1, c.y2) : Math.max(c.x1, c.x2);
                    if (axis === 'h') {
                        if (Math.abs(ex - cLine) <= CFG.SNAP && ey >= cMin - CFG.SNAP && ey <= cMax + CFG.SNAP) (w as any)[`x${end}`] = cLine;
                    } else if (Math.abs(ey - cLine) <= CFG.SNAP && ex >= cMin - CFG.SNAP && ex <= cMax + CFG.SNAP) {
                        (w as any)[`y${end}`] = cLine;
                    }
                }
            }
        }
    }

    private async extractText(page: any, viewport: any, Util: any): Promise<TextElement[]> {
        const content = await page.getTextContent();
        const out: TextElement[] = [];
        for (const item of content.items) {
            const str: string = (item.str ?? '').trim();
            if (!str) continue;
            const p = Util.applyTransform([item.transform[4], item.transform[5]], viewport.transform);
            const height = Math.max(2, item.height || 8);
            const width = Math.max(1, item.width || str.length * height * 0.5);
            out.push({
                x: p[0], y: p[1] - height / 2,
                text: str,
                confidence: 1,
                boundingBox: { x: p[0], y: p[1] - height, width, height },
                angle: 0,
                category: this.classify(str),
            });
        }
        return out;
    }

    private classify(text: string): TextElement['category'] {
        if (/^\d+([.,]\d+)?$/.test(text)) return 'dimension';
        if (/kitchen|bed|bath|living|hall|office|closet|wc|toilet|room|dining|[Α-Ωα-ω]{3,}/.test(text)) return 'room';
        return 'label';
    }

    /**
     * Recover real-world scale (mm per PDF point) from dimension texts.
     * Decimal dimension values (metres) laid out in a chain are spaced in
     * proportion to the lengths they annotate, so adjacent-text spacing votes a
     * scale. The vote is weak on schedule-heavy drawings, so it is corroborated
     * against wall thickness (interior walls are ~0.05-0.25m) before being
     * trusted. Returns confidence in [0,1]; callers should gate on it.
     */
    private estimateScale(textElements: TextElement[], wallLines: WallLine[]): { mmPerPt: number; confidence: number; votes: number } {
        const dims = textElements
            .filter((t) => /^\d+[.,]\d+$/.test(t.text))
            .map((t) => ({ v: parseFloat(t.text.replace(',', '.')), x: t.x, y: t.y }))
            .filter((d) => d.v >= 0.2 && d.v <= 25);

        const groupVote = (key: 'x' | 'y', span: 'x' | 'y'): number[] => {
            const sorted = [...dims].sort((a, b) => a[key] - b[key] || a[span] - b[span]);
            const groups: Array<{ k: number; items: typeof dims }> = [];
            for (const d of sorted) {
                let g = groups.find((g) => Math.abs(g.k - d[key]) < 6);
                if (!g) { g = { k: d[key], items: [] }; groups.push(g); }
                g.items.push(d); g.k = (g.k * (g.items.length - 1) + d[key]) / g.items.length;
            }
            const out: number[] = [];
            for (const g of groups) {
                g.items.sort((a, b) => a[span] - b[span]);
                for (let i = 0; i < g.items.length - 1; i++) {
                    const d = g.items[i + 1][span] - g.items[i][span];
                    if (d < 4) continue;
                    const s = ((g.items[i].v + g.items[i + 1].v) / 2) / d; // m per pt
                    if (s > 0.003 && s < 0.06) out.push(s);
                }
            }
            return out;
        };
        const votes = [...groupVote('y', 'x'), ...groupVote('x', 'y')].sort((a, b) => a - b);
        if (votes.length < 4) return { mmPerPt: 0, confidence: 0, votes: votes.length };

        const mPerPt = votes[Math.floor(votes.length / 2)];
        const tight = votes.filter((s) => Math.abs(s - mPerPt) <= 0.15 * mPerPt).length;
        let confidence = tight / votes.length;

        // Corroborate with wall thickness: double-line gap should map to a real
        // interior-wall thickness. Agreement lifts confidence; conflict caps it.
        const gaps = wallLines.filter((w) => w.thickness > 2).map((w) => w.thickness).sort((a, b) => a - b);
        if (gaps.length) {
            const realThick = gaps[Math.floor(gaps.length / 2)] * mPerPt; // metres
            if (realThick >= 0.04 && realThick <= 0.3) confidence = Math.min(0.85, confidence + 0.2);
            else confidence = Math.min(confidence, 0.3);
        }
        return { mmPerPt: mPerPt * 1000, confidence, votes: votes.length };
    }

    private assemble(imagePath: string, width: number, height: number, wallLines: WallLine[], textElements: TextElement[]): FloorPlan {
        const walls: Wall[] = wallLines.map((w) => ({
            id: uuidv4(),
            startPoint: { x: w.x1, y: w.y1 },
            endPoint: { x: w.x2, y: w.y2 },
            thickness: w.thickness,
            height: 2400,
            confidence: 0.9,
            orientation: w.orientation,
        }));
        const totalWallLength = walls.reduce((s, w) => s + Math.hypot(w.endPoint.x - w.startPoint.x, w.endPoint.y - w.startPoint.y), 0);

        // Apply the recovered scale only when corroborated; otherwise keep the
        // drawing in points (scale 1) and flag it for manual confirmation.
        const scaleEst = this.estimateScale(textElements, wallLines);
        const applyScale = scaleEst.confidence >= 0.4;
        const scale = applyScale ? scaleEst.mmPerPt : 1;
        const unit: FloorPlan['unit'] = applyScale ? 'mm' : 'px';

        const metrics: ExtractionMetrics = {
            wallCount: walls.length,
            openingCount: 0,
            furnitureCount: 0,
            dimensionCount: textElements.filter((t) => t.category === 'dimension').length,
            textCount: textElements.length,
            roomCount: 0,
            junctionCount: 0,
            wallConfidence: walls.length ? 0.9 : 0,
            textConfidence: 1,
            scaleConfidence: scaleEst.confidence,
            totalWallLength,
            averageWallThickness: walls.length ? walls.reduce((s, w) => s + w.thickness, 0) / walls.length : 0,
        };
        const now = new Date();
        return {
            id: uuidv4(),
            imagePath,
            width,
            height,
            scale,
            unit,
            walls,
            openings: [],
            furniture: [],
            dimensions: [],
            textElements,
            rooms: [],
            metrics,
            createdAt: now,
            updatedAt: now,
        };
    }
}
