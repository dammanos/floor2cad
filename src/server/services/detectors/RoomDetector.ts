import { MeasurementUnit, Room, TextElement, Wall } from '../../../shared/types';
import { createBoundingBox, drawWallMask, findConnectedComponents, pointInBoundingBox, smoothOrthogonalBoundary, traceComponentBoundary } from './DetectionUtils';
import { v4 as uuidv4 } from 'uuid';

export class RoomDetector {
    detect(
        width: number,
        height: number,
        walls: Wall[],
        textElements: TextElement[],
        scale: number,
        unit: MeasurementUnit,
    ): Room[] {
        const wallMask = drawWallMask(walls, width, height, 2);
        const freeSpaceMask = new Uint8ClampedArray(width * height);

        for (let index = 0; index < freeSpaceMask.length; index += 1) {
            freeSpaceMask[index] = wallMask[index] ? 0 : 1;
        }

        const minArea = Math.max(100, Math.round((width * height) * 0.0015));
        const components = findConnectedComponents(freeSpaceMask, width, height, minArea);

        return components
            .filter((component) => !component.touchesBorder)
            .map((component) => {
                const boundingBox = createBoundingBox(component.minX, component.minY, component.maxX, component.maxY);
                const boundary = smoothOrthogonalBoundary(traceComponentBoundary(freeSpaceMask, width, height, component));
                const roomLabel = textElements.find((textElement) => (
                    textElement.category === 'room'
                    && pointInBoundingBox({ x: textElement.x, y: textElement.y }, boundingBox)
                ));
                const area = unit === 'm'
                    ? component.area * Math.pow(scale, 2)
                    : component.area;

                return {
                    id: uuidv4(),
                    name: roomLabel?.text,
                    boundary,
                    centroid: component.centroid,
                    area,
                    confidence: Math.min(0.9, 0.4 + component.fillRatio * 0.35 + Math.min(boundary.length / 40, 0.1)),
                    labelId: roomLabel?.text,
                    boundingBox,
                } as Room;
            })
            .slice(0, 30);
    }
}
