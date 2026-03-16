import { AnalysisImageData } from '../ImageProcessor';
import { Opening, Wall } from '../../../shared/types';
import { clamp, distance, getIndex } from './DetectionUtils';
import { v4 as uuidv4 } from 'uuid';

export class OpeningDetector {
    detect(walls: Wall[], analysis: AnalysisImageData): Opening[] {
        const openings: Opening[] = [];

        for (const wall of walls) {
            const candidates = this.detectWallGaps(wall, analysis);
            openings.push(...candidates);
        }

        return this.deduplicate(openings).slice(0, 40);
    }

    private detectWallGaps(wall: Wall, analysis: AnalysisImageData): Opening[] {
        const length = distance(wall.startPoint, wall.endPoint);
        if (length < 40) {
            return [];
        }

        const isHorizontal = Math.abs(wall.endPoint.x - wall.startPoint.x) >= Math.abs(wall.endPoint.y - wall.startPoint.y);
        const samples = Math.max(8, Math.round(length));
        const gapMinLength = Math.max(10, Math.round(length * 0.04));
        const gapMaxLength = Math.max(gapMinLength + 2, Math.round(length * 0.35));
        const occupancy: number[] = [];
        const radius = Math.max(1, Math.round(wall.thickness / 2) + 1);

        for (let step = 0; step <= samples; step += 1) {
            const t = step / samples;
            const x = wall.startPoint.x + (wall.endPoint.x - wall.startPoint.x) * t;
            const y = wall.startPoint.y + (wall.endPoint.y - wall.startPoint.y) * t;
            occupancy.push(this.sampleCrossSection(x, y, radius, isHorizontal, analysis));
        }

        const openings: Opening[] = [];
        let start = -1;
        for (let index = 0; index < occupancy.length; index += 1) {
            const isGap = occupancy[index] < 0.25;
            if (isGap && start === -1) {
                start = index;
            }

            const shouldClose = (!isGap || index === occupancy.length - 1) && start !== -1;
            if (!shouldClose) {
                continue;
            }

            const end = isGap && index === occupancy.length - 1 ? index : index - 1;
            const gapLength = end - start + 1;
            const edgeConfidence = this.edgeSupport(start, end, occupancy);
            if (
                gapLength >= gapMinLength
                && gapLength <= gapMaxLength
                && start > 1
                && end < occupancy.length - 2
                && edgeConfidence >= 0.18
            ) {
                const startT = start / samples;
                const endT = end / samples;
                const centerT = (startT + endT) / 2;
                const centerX = wall.startPoint.x + (wall.endPoint.x - wall.startPoint.x) * centerT;
                const centerY = wall.startPoint.y + (wall.endPoint.y - wall.startPoint.y) * centerT;
                const width = distance(
                    {
                        x: wall.startPoint.x + (wall.endPoint.x - wall.startPoint.x) * startT,
                        y: wall.startPoint.y + (wall.endPoint.y - wall.startPoint.y) * startT,
                    },
                    {
                        x: wall.startPoint.x + (wall.endPoint.x - wall.startPoint.x) * endT,
                        y: wall.startPoint.y + (wall.endPoint.y - wall.startPoint.y) * endT,
                    },
                );

                openings.push({
                    id: uuidv4(),
                    position: { x: centerX, y: centerY },
                    type: this.classifyOpening(width, wall, edgeConfidence),
                    width,
                    height: Math.max(10, wall.thickness * 1.25),
                    angle: isHorizontal ? 0 : 90,
                    confidence: Math.min(0.9, 0.35 + Math.min(0.25, gapLength / samples) + edgeConfidence),
                    wallId: wall.id,
                    boundingBox: isHorizontal
                        ? { x: centerX - width / 2, y: centerY - radius, width, height: radius * 2 }
                        : { x: centerX - radius, y: centerY - width / 2, width: radius * 2, height: width },
                });
            }

            start = -1;
        }

        return openings;
    }

    private classifyOpening(width: number, wall: Wall, edgeConfidence: number): Opening['type'] {
        const relativeWidth = width / Math.max(1, wall.thickness);

        if (relativeWidth >= 12) {
            return 'double_door';
        }

        if (relativeWidth >= 8) {
            return edgeConfidence > 0.35 ? 'door' : 'sliding_door';
        }

        if (relativeWidth >= 5) {
            return 'door';
        }

        return 'window';
    }

    private edgeSupport(start: number, end: number, occupancy: number[]): number {
        const left = start > 0 ? occupancy[start - 1] : 0;
        const right = end < occupancy.length - 1 ? occupancy[end + 1] : 0;
        const gap = occupancy.slice(start, end + 1);
        const averageGap = gap.reduce((sum, value) => sum + value, 0) / Math.max(1, gap.length);

        return Math.max(0, ((left + right) / 2) - averageGap);
    }

    private deduplicate(openings: Opening[]): Opening[] {
        const deduped: Opening[] = [];

        for (const opening of openings.sort((a, b) => b.confidence - a.confidence)) {
            const overlap = deduped.some((existing) => (
                existing.wallId === opening.wallId
                && Math.abs(existing.position.x - opening.position.x) <= Math.max(existing.width, opening.width) * 0.35
                && Math.abs(existing.position.y - opening.position.y) <= Math.max(existing.height, opening.height) * 0.35
            ));

            if (!overlap) {
                deduped.push(opening);
            }
        }

        return deduped;
    }

    private sampleCrossSection(x: number, y: number, radius: number, isHorizontal: boolean, analysis: AnalysisImageData): number {
        let darkPixels = 0;
        let totalPixels = 0;
        const centerX = clamp(Math.round(x), 0, analysis.width - 1);
        const centerY = clamp(Math.round(y), 0, analysis.height - 1);

        for (let offset = -radius; offset <= radius; offset += 1) {
            const sampleX = isHorizontal ? centerX : clamp(centerX + offset, 0, analysis.width - 1);
            const sampleY = isHorizontal ? clamp(centerY + offset, 0, analysis.height - 1) : centerY;
            const pixel = analysis.binary[getIndex(sampleX, sampleY, analysis.width)];
            if (pixel > 0) {
                darkPixels += 1;
            }
            totalPixels += 1;
        }

        return totalPixels > 0 ? darkPixels / totalPixels : 0;
    }
}
