import { AnalysisImageData } from '../ImageProcessor';
import { Furniture, TextElement, Wall } from '../../../shared/types';
import { createBoundingBox, drawBoundingBox, drawWallMask, findConnectedComponents } from './DetectionUtils';
import { v4 as uuidv4 } from 'uuid';

export class FurnitureDetector {
    detect(analysis: AnalysisImageData, walls: Wall[], textElements: TextElement[]): Furniture[] {
        const candidateMask = new Uint8ClampedArray(analysis.binary);
        const wallMask = drawWallMask(walls, analysis.width, analysis.height, 3);

        for (let index = 0; index < candidateMask.length; index += 1) {
            if (wallMask[index]) {
                candidateMask[index] = 0;
            }
        }

        for (const textElement of textElements) {
            drawBoundingBox(candidateMask, analysis.width, analysis.height, textElement.boundingBox, 0, 4);
        }

        const minArea = Math.max(30, Math.round((analysis.width * analysis.height) * 0.00008));
        const maxArea = Math.max(minArea + 1, Math.round((analysis.width * analysis.height) * 0.03));
        const components = findConnectedComponents(candidateMask, analysis.width, analysis.height, minArea);

        return components
            .filter((component) => !component.touchesBorder && component.area <= maxArea)
            .map((component) => {
                const width = component.maxX - component.minX + 1;
                const height = component.maxY - component.minY + 1;
                const aspectRatio = width / Math.max(1, height);
                const type = this.classify(width, height, aspectRatio, component.fillRatio);
                return {
                    id: uuidv4(),
                    position: component.centroid,
                    type,
                    width,
                    depth: height,
                    angle: aspectRatio >= 1 ? 0 : 90,
                    confidence: Math.min(0.8, 0.35 + component.fillRatio * 0.4),
                    label: `${type}`,
                    boundingBox: createBoundingBox(component.minX, component.minY, component.maxX, component.maxY),
                } as Furniture;
            })
            .slice(0, 25);
    }

    private classify(width: number, height: number, aspectRatio: number, fillRatio: number): string {
        const area = width * height;
        if (aspectRatio > 2.4) {
            return area > 1800 ? 'kitchen_counter' : 'sofa';
        }

        if (aspectRatio < 0.45) {
            return 'wardrobe';
        }

        if (fillRatio > 0.7 && area > 900) {
            return 'table';
        }

        if (area > 2200) {
            return 'bed';
        }

        return 'furniture';
    }
}
