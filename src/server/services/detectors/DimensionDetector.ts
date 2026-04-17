import { Dimension, MeasurementUnit, TextElement, Wall } from '../../../shared/types';
import { distance } from './DetectionUtils';
import { v4 as uuidv4 } from 'uuid';

const dimensionPattern = /(\d+(?:[.,]\d+)?)(?:\s?(mm|cm|m|ft|in|"|'))?/i;

interface ScaleResult {
    scale: number;
    unit: MeasurementUnit;
    confidence: number;
}

interface CalibrationSample {
    pixelLength: number;
    realLength: number;
    ratio: number;
}

export class DimensionDetector {
    detect(textElements: TextElement[], walls: Wall[]): { dimensions: Dimension[]; scaleResult: ScaleResult } {
        const dimensions = textElements
            .map((text) => this.toDimension(text, walls))
            .filter((dimension): dimension is Dimension => Boolean(dimension));

        return {
            dimensions,
            scaleResult: this.estimateScale(dimensions),
        };
    }

    private toDimension(textElement: TextElement, walls: Wall[]): Dimension | null {
        const match = textElement.text.match(dimensionPattern);
        if (!match) {
            return null;
        }

        const value = Number.parseFloat(match[1].replace(',', '.'));
        if (!Number.isFinite(value)) {
            return null;
        }

        const unit = this.parseUnit(match[2]);
        const parallelWall = this.findParallelWall(textElement, walls);
        const length = parallelWall
            ? distance(parallelWall.startPoint, parallelWall.endPoint)
            : textElement.boundingBox.width * 4;

        return {
            id: uuidv4(),
            length,
            position: {
                x: textElement.x,
                y: textElement.y,
            },
            value,
            unit,
            confidence: Math.max(0.35, textElement.confidence),
            startPoint: parallelWall?.startPoint,
            endPoint: parallelWall?.endPoint,
            sourceText: textElement.text,
        };
    }

    private parseUnit(rawUnit?: string): MeasurementUnit {
        const normalizedUnit = (rawUnit || '').toLowerCase();
        switch (normalizedUnit) {
            case 'mm':
                return 'mm';
            case 'cm':
                return 'cm';
            case 'm':
                return 'm';
            case 'ft':
            case "'":
                return 'ft';
            case 'in':
            case '"':
                return 'in';
            default:
                return 'px';
        }
    }

    /**
     * Find the wall that the dimension label most likely annotates.
     * A dimension text is usually placed alongside, and parallel to, its wall.
     * We score candidates by (1) orientation match against the text's angle,
     * (2) perpendicular distance, and (3) overlap between the text bbox and the
     * wall's axis extent.
     */
    private findParallelWall(textElement: TextElement, walls: Wall[]): Wall | undefined {
        const horizontalPreferred = Math.abs(textElement.angle) % 180 < 45;
        const candidates = walls
            .map((wall) => ({
                wall,
                score: this.scoreWallForDimension(textElement, wall, horizontalPreferred),
            }))
            .filter((candidate) => candidate.score > 0)
            .sort((a, b) => b.score - a.score);

        return candidates[0]?.wall;
    }

    private scoreWallForDimension(textElement: TextElement, wall: Wall, horizontalPreferred: boolean): number {
        const textSize = Math.max(textElement.boundingBox.width, textElement.boundingBox.height);
        const orientation = wall.orientation ?? this.inferOrientation(wall);
        const orientationMatch = (horizontalPreferred && orientation === 'horizontal')
            || (!horizontalPreferred && orientation === 'vertical');

        const perpendicularDistance = this.perpendicularDistanceToWall(textElement, wall);
        const maxPerpendicular = Math.max(textSize * 6, 40);
        if (perpendicularDistance > maxPerpendicular) {
            return 0;
        }

        const extentOverlap = this.projectionOverlap(textElement, wall, orientation);
        if (extentOverlap <= 0) {
            return 0;
        }

        const distanceScore = 1 - perpendicularDistance / maxPerpendicular;
        const overlapScore = Math.min(1, extentOverlap / Math.max(textSize, 1));
        const orientationScore = orientationMatch ? 1.2 : 0.6;

        return distanceScore * 0.5 + overlapScore * 0.3 + orientationScore * 0.2;
    }

    private inferOrientation(wall: Wall): 'horizontal' | 'vertical' | 'diagonal' {
        const dx = Math.abs(wall.endPoint.x - wall.startPoint.x);
        const dy = Math.abs(wall.endPoint.y - wall.startPoint.y);
        if (dy < dx * 0.2) return 'horizontal';
        if (dx < dy * 0.2) return 'vertical';
        return 'diagonal';
    }

    private perpendicularDistanceToWall(textElement: TextElement, wall: Wall): number {
        const x1 = wall.startPoint.x;
        const y1 = wall.startPoint.y;
        const x2 = wall.endPoint.x;
        const y2 = wall.endPoint.y;
        const dx = x2 - x1;
        const dy = y2 - y1;
        const lengthSq = dx * dx + dy * dy;
        if (lengthSq === 0) {
            return Math.hypot(textElement.x - x1, textElement.y - y1);
        }
        const numerator = Math.abs(dy * textElement.x - dx * textElement.y + x2 * y1 - y2 * x1);
        return numerator / Math.sqrt(lengthSq);
    }

    private projectionOverlap(
        textElement: TextElement,
        wall: Wall,
        orientation: 'horizontal' | 'vertical' | 'diagonal',
    ): number {
        if (orientation === 'horizontal') {
            const wallStart = Math.min(wall.startPoint.x, wall.endPoint.x);
            const wallEnd = Math.max(wall.startPoint.x, wall.endPoint.x);
            const textStart = textElement.boundingBox.x;
            const textEnd = textElement.boundingBox.x + textElement.boundingBox.width;
            return Math.max(0, Math.min(wallEnd, textEnd) - Math.max(wallStart, textStart));
        }
        if (orientation === 'vertical') {
            const wallStart = Math.min(wall.startPoint.y, wall.endPoint.y);
            const wallEnd = Math.max(wall.startPoint.y, wall.endPoint.y);
            const textStart = textElement.boundingBox.y;
            const textEnd = textElement.boundingBox.y + textElement.boundingBox.height;
            return Math.max(0, Math.min(wallEnd, textEnd) - Math.max(wallStart, textStart));
        }
        // Diagonal walls: fall back to a radial proximity check in pixels.
        const centerX = (wall.startPoint.x + wall.endPoint.x) / 2;
        const centerY = (wall.startPoint.y + wall.endPoint.y) / 2;
        const radius = distance(wall.startPoint, wall.endPoint) / 2;
        const centerDistance = Math.hypot(textElement.x - centerX, textElement.y - centerY);
        return Math.max(0, radius - centerDistance);
    }

    private estimateScale(dimensions: Dimension[]): ScaleResult {
        const samples: CalibrationSample[] = [];
        for (const dimension of dimensions) {
            if (dimension.unit === 'px' || dimension.length <= 0) {
                continue;
            }
            const realMeters = this.convertToMeters(dimension.value, dimension.unit);
            if (realMeters <= 0) {
                continue;
            }
            samples.push({
                pixelLength: dimension.length,
                realLength: realMeters,
                ratio: realMeters / dimension.length,
            });
        }

        if (!samples.length) {
            return { scale: 1, unit: 'px', confidence: 0.2 };
        }

        const { scale, inlierCount } = this.ransacScale(samples);
        const totalSamples = samples.length;
        const inlierRatio = totalSamples > 0 ? inlierCount / totalSamples : 0;
        const confidence = Math.min(0.97, 0.4 + Math.min(inlierCount, 6) * 0.08 + inlierRatio * 0.2);

        return {
            scale,
            unit: 'm',
            confidence,
        };
    }

    /**
     * RANSAC over (pixel, real) pairs: repeatedly pick one sample as a
     * hypothesis, count how many other samples agree within a relative tolerance,
     * keep the consensus with the most agreement, then average the inliers.
     */
    private ransacScale(samples: CalibrationSample[]): { scale: number; inlierCount: number } {
        if (samples.length === 1) {
            return { scale: samples[0].ratio, inlierCount: 1 };
        }

        const tolerance = 0.08; // 8% relative tolerance
        let bestInliers: CalibrationSample[] = [];

        for (const candidate of samples) {
            const inliers = samples.filter((other) => {
                const relativeDelta = Math.abs(other.ratio - candidate.ratio) / Math.max(candidate.ratio, 1e-9);
                return relativeDelta <= tolerance;
            });

            if (inliers.length > bestInliers.length) {
                bestInliers = inliers;
            }
        }

        if (bestInliers.length === 0) {
            const ratios = [...samples.map((s) => s.ratio)].sort((a, b) => a - b);
            const middle = Math.floor(ratios.length / 2);
            const median = ratios.length % 2 === 0 ? (ratios[middle - 1] + ratios[middle]) / 2 : ratios[middle];
            return { scale: median, inlierCount: 0 };
        }

        // Weighted average of inliers by pixel length — longer walls give more signal.
        const weightedTotal = bestInliers.reduce((sum, sample) => sum + sample.ratio * sample.pixelLength, 0);
        const totalWeight = bestInliers.reduce((sum, sample) => sum + sample.pixelLength, 0);
        const scale = totalWeight > 0 ? weightedTotal / totalWeight : bestInliers[0].ratio;
        return { scale, inlierCount: bestInliers.length };
    }

    private convertToMeters(value: number, unit: MeasurementUnit): number {
        switch (unit) {
            case 'mm':
                return value / 1000;
            case 'cm':
                return value / 100;
            case 'm':
                return value;
            case 'ft':
                return value * 0.3048;
            case 'in':
                return value * 0.0254;
            default:
                return 0;
        }
    }
}
