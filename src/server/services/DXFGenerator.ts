import {
    DxfWriter,
    Colors,
    LWPolylineFlags,
    point3d,
    point2d,
} from '@tarikjabiri/dxf';
import { FloorPlan, MeasurementUnit, Point } from '../../shared/types';

// Shorthand vertex for LWPolyline
const vtx = (x: number, y: number) => ({ point: point2d(x, y) });

const INSUNITS_BY_UNIT: Record<MeasurementUnit, number> = {
    px: 0,
    mm: 4,
    cm: 5,
    m: 6,
    in: 1,
    ft: 2,
};

export class DXFGenerator {
    generate(floorPlan: FloorPlan): string {
        const doc = new DxfWriter();

        const unit = floorPlan.unit;
        const usePixelSpace = unit === 'px' || floorPlan.scale <= 0;
        const scale = usePixelSpace ? 1 : floorPlan.scale;
        const imgH = floorPlan.height;

        // Set $INSUNITS so CAD viewers interpret the drawing correctly.
        const insunits = INSUNITS_BY_UNIT[unit] ?? 0;
        if (typeof (doc as unknown as { setVariable?: (name: string, values: Record<number, unknown>) => void }).setVariable === 'function') {
            (doc as unknown as { setVariable: (name: string, values: Record<number, unknown>) => void })
                .setVariable('$INSUNITS', { 70: insunits });
        }

        // Helper: transform pixel coords → DXF coords (Y-flip + scale)
        const tx = (p: Point) => ({
            x: p.x * scale,
            y: (imgH - p.y) * scale,
        });

        // ── Layers ──────────────────────────────────────────────
        doc.addLayer('WALLS', Colors.White);
        doc.addLayer('WALL_FILL', Colors.Yellow);
        doc.addLayer('OPENINGS', Colors.Cyan);
        doc.addLayer('ROOMS', Colors.Green);
        doc.addLayer('ROOM_LABELS', Colors.Green);
        doc.addLayer('FURNITURE', Colors.Magenta);
        doc.addLayer('DIMENSIONS', Colors.Red);
        doc.addLayer('DIMENSION_TEXT', Colors.Red);
        doc.addLayer('TEXT', Colors.Blue);

        // ── Walls ───────────────────────────────────────────────
        for (const wall of floorPlan.walls) {
            const sp = tx(wall.startPoint);
            const ep = tx(wall.endPoint);

            if (wall.thickness > 1) {
                const dx = ep.x - sp.x;
                const dy = ep.y - sp.y;
                const len = Math.sqrt(dx * dx + dy * dy);
                if (len > 0) {
                    const halfT = (wall.thickness * scale) / 2;
                    const nx = (-dy / len) * halfT;
                    const ny = (dx / len) * halfT;

                    doc.addLWPolyline(
                        [
                            vtx(sp.x + nx, sp.y + ny),
                            vtx(ep.x + nx, ep.y + ny),
                            vtx(ep.x - nx, ep.y - ny),
                            vtx(sp.x - nx, sp.y - ny),
                        ],
                        { flags: LWPolylineFlags.Closed, layerName: 'WALL_FILL' },
                    );
                }
            }

            doc.addLine(
                point3d(sp.x, sp.y),
                point3d(ep.x, ep.y),
                { layerName: 'WALLS' },
            );
        }

        // ── Openings ────────────────────────────────────────────
        for (const opening of floorPlan.openings) {
            const center = tx(opening.position);
            const hw = (opening.width * scale) / 2;
            const hh = (opening.height * scale) / 2;

            doc.addLWPolyline(
                [
                    vtx(center.x - hw, center.y - hh),
                    vtx(center.x + hw, center.y - hh),
                    vtx(center.x + hw, center.y + hh),
                    vtx(center.x - hw, center.y + hh),
                ],
                { flags: LWPolylineFlags.Closed, layerName: 'OPENINGS' },
            );
        }

        // ── Furniture ───────────────────────────────────────────
        for (const item of floorPlan.furniture) {
            const center = tx(item.position);
            const hw = (item.width * scale) / 2;
            const hd = (item.depth * scale) / 2;

            doc.addLWPolyline(
                [
                    vtx(center.x - hw, center.y - hd),
                    vtx(center.x + hw, center.y - hd),
                    vtx(center.x + hw, center.y + hd),
                    vtx(center.x - hw, center.y + hd),
                ],
                { flags: LWPolylineFlags.Closed, layerName: 'FURNITURE' },
            );
        }

        // ── Dimensions ──────────────────────────────────────────
        for (const dim of floorPlan.dimensions) {
            const p = tx(dim.position);
            const dimLen = Math.max(1, dim.length) * scale;

            doc.addLine(
                point3d(p.x, p.y),
                point3d(p.x + dimLen, p.y),
                { layerName: 'DIMENSIONS' },
            );

            // Text is rendered in DXF Y-up space; no additional rotation needed
            // for horizontal dimensions. Vertical dimensions are rotated 90°.
            doc.addText(
                point3d(p.x + dimLen / 2, p.y + Math.max(1.5, 2 * scale)),
                Math.max(1.5, 2.5 * scale),
                `${dim.value} ${dim.unit}`,
                { layerName: 'DIMENSION_TEXT' },
            );
        }

        // ── Text elements ───────────────────────────────────────
        for (const text of floorPlan.textElements) {
            const p = tx({ x: text.x, y: text.y });
            const textHeight = Math.max(1.5, Math.abs(text.boundingBox.height) * scale * 0.7);

            doc.addText(
                point3d(p.x, p.y),
                textHeight,
                text.text,
                { layerName: 'TEXT' },
            );
        }

        // ── Rooms ───────────────────────────────────────────────
        for (const room of floorPlan.rooms) {
            if (room.boundary.length < 3) continue;

            const points = room.boundary.map((pt) => {
                const t = tx(pt);
                return vtx(t.x, t.y);
            });

            doc.addLWPolyline(
                points,
                { flags: LWPolylineFlags.Closed, layerName: 'ROOMS' },
            );

            if (room.name) {
                const c = tx(room.centroid);
                doc.addText(
                    point3d(c.x, c.y),
                    Math.max(1.5, 3 * scale),
                    room.name,
                    { layerName: 'ROOM_LABELS' },
                );
            }
        }

        return doc.stringify();
    }
}
