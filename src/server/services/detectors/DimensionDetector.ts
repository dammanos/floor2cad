import { Dimension, MeasurementUnit, TextElement, Wall } from '../../../shared/types';
import { distance } from './DetectionUtils';
import { v4 as uuidv4 } from 'uuid';

const dimensionPattern = /(\d+(?:[.,]\d+)?)(?:\s?(mm|cm|m|ft|in|"|'))?/i;

interface ScaleResult {
    scale: number;
    unit: MeasurementUnit;
    confidence: number;
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
        const nearestWall = this.findNearestWall(textElement, walls);
        const length = nearestWall ? distance(nearestWall.startPoint, nearestWall.endPoint) : textElement.boundingBox.width * 4;

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
            startPoint: nearestWall?.startPoint,
            endPoint: nearestWall?.endPoint,
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

    private findNearestWall(textElement: TextElement, walls: Wall[]): Wall | undefined {
        const maxDistance = Math.max(textElement.boundingBox.width, textElement.boundingBox.height) * 6;
        return walls
            .map((wall) => ({ wall, distance: this.distanceToWall(textElement, wall) }))
            .filter((candidate) => candidate.distance <= maxDistance)
            .sort((a, b) => a.distance - b.distance)[0]?.wall;
    }

    private distanceToWall(textElement: TextElement, wall: Wall): number {
        const centerX = (wall.startPoint.x + wall.endPoint.x) / 2;
        const centerY = (wall.startPoint.y + wall.endPoint.y) / 2;
        return Math.hypot(textElement.x - centerX, textElement.y - centerY);
    }

    private estimateScale(dimensions: Dimension[]): ScaleResult {
        const candidates = dimensions
            .map((dimension) => {
                if (dimension.unit === 'px' || dimension.length <= 0) {
                    return null;
                }

                const valueInMeters = this.convertToMeters(dimension.value, dimension.unit);
                if (valueInMeters <= 0) {
                    return null;
                }

                return valueInMeters / dimension.length;
            })
            .filter((candidate): candidate is number => Boolean(candidate) && Number.isFinite(candidate));

        if (!candidates.length) {
            return {
                scale: 1,
                unit: 'px',
                confidence: 0.2,
            };
        }

        const sorted = [...candidates].sort((a, b) => a - b);
        const middle = Math.floor(sorted.length / 2);
        const scale = sorted.length % 2 === 0
            ? (sorted[middle - 1] + sorted[middle]) / 2
            : sorted[middle];

        const confidence = Math.min(0.95, 0.45 + Math.min(candidates.length, 5) * 0.1);
        return {
            scale,
            unit: 'm',
            confidence,
        };
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
