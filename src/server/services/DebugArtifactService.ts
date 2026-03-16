import { promises as fs } from 'fs';
import path from 'path';
import { FloorPlan } from '../../shared/types';

export interface DebugArtifacts {
    directory: string;
    overlaySvgPath: string;
    summaryJsonPath: string;
}

export class DebugArtifactService {
    async writeArtifacts(outputRoot: string, floorPlan: FloorPlan): Promise<DebugArtifacts> {
        const debugDir = path.join(outputRoot, 'debug', floorPlan.id);
        await fs.mkdir(debugDir, { recursive: true });

        const overlaySvgPath = path.join(debugDir, 'overlay.svg');
        const summaryJsonPath = path.join(debugDir, 'summary.json');

        await fs.writeFile(overlaySvgPath, this.buildOverlaySvg(floorPlan), 'utf8');
        await fs.writeFile(summaryJsonPath, JSON.stringify(this.buildSummary(floorPlan), null, 2), 'utf8');

        return {
            directory: debugDir,
            overlaySvgPath,
            summaryJsonPath,
        };
    }

    private buildOverlaySvg(floorPlan: FloorPlan): string {
        const wallLines = floorPlan.walls.map((wall) => (
            `<line x1="${wall.startPoint.x}" y1="${wall.startPoint.y}" x2="${wall.endPoint.x}" y2="${wall.endPoint.y}" stroke="#ff3b30" stroke-width="${Math.max(2, wall.thickness / 2)}" stroke-linecap="round" opacity="0.8" />`
        )).join('\n');

        const openingShapes = floorPlan.openings.map((opening) => (
            `<rect x="${opening.position.x - opening.width / 2}" y="${opening.position.y - opening.height / 2}" width="${opening.width}" height="${opening.height}" fill="none" stroke="#007aff" stroke-width="2" opacity="0.9" />`
        )).join('\n');

        const roomPolygons = floorPlan.rooms.map((room) => {
            const points = room.boundary.map((point) => `${point.x},${point.y}`).join(' ');
            return `<polygon points="${points}" fill="rgba(52,199,89,0.15)" stroke="#34c759" stroke-width="2" />`;
        }).join('\n');

        const textLabels = floorPlan.textElements.map((textElement) => (
            `<g><rect x="${textElement.boundingBox.x}" y="${textElement.boundingBox.y}" width="${textElement.boundingBox.width}" height="${textElement.boundingBox.height}" fill="none" stroke="#ffcc00" stroke-width="1" /><text x="${textElement.x}" y="${textElement.y}" fill="#ffcc00" font-size="10">${this.escapeXml(textElement.text)}</text></g>`
        )).join('\n');

        const furnitureShapes = floorPlan.furniture.map((item) => {
            if (!item.boundingBox) {
                return '';
            }

            return `<rect x="${item.boundingBox.x}" y="${item.boundingBox.y}" width="${item.boundingBox.width}" height="${item.boundingBox.height}" fill="none" stroke="#af52de" stroke-width="2" opacity="0.8" />`;
        }).join('\n');

        return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${floorPlan.width} ${floorPlan.height}" width="${floorPlan.width}" height="${floorPlan.height}">
  <rect width="100%" height="100%" fill="#111" />
  ${roomPolygons}
  ${wallLines}
  ${openingShapes}
  ${furnitureShapes}
  ${textLabels}
</svg>`;
    }

    private buildSummary(floorPlan: FloorPlan) {
        return {
            id: floorPlan.id,
            imagePath: floorPlan.imagePath,
            width: floorPlan.width,
            height: floorPlan.height,
            unit: floorPlan.unit,
            scale: floorPlan.scale,
            metrics: floorPlan.metrics,
            counts: {
                walls: floorPlan.walls.length,
                openings: floorPlan.openings.length,
                furniture: floorPlan.furniture.length,
                dimensions: floorPlan.dimensions.length,
                texts: floorPlan.textElements.length,
                rooms: floorPlan.rooms.length,
            },
        };
    }

    private escapeXml(value: string): string {
        return value
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
    }
}
