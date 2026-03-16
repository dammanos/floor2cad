import { ImageProcessor } from './ImageProcessor';
import { DXFGenerator } from './DXFGenerator';
import { WallDetector } from './detectors/WallDetector';
import { DimensionDetector } from './detectors/DimensionDetector';
import { FurnitureDetector } from './detectors/FurnitureDetector';
import { OpeningDetector } from './detectors/OpeningDetector';
import { RoomDetector } from './detectors/RoomDetector';
import { TextDetector } from './detectors/TextDetector';
import { boxesOverlap, mergeBoundingBoxes } from './detectors/DetectionUtils';
import { ExtractionMetrics, FloorPlan, MLStatus } from '../../shared/types';
import { MLServiceClient } from './MLServiceClient';
import { v4 as uuidv4 } from 'uuid';

export class FloorPlanConverter {
    private imageProcessor: ImageProcessor;
    private dxfGenerator: DXFGenerator;
    private wallDetector: WallDetector;
    private textDetector: TextDetector;
    private dimensionDetector: DimensionDetector;
    private openingDetector: OpeningDetector;
    private furnitureDetector: FurnitureDetector;
    private roomDetector: RoomDetector;
    private mlServiceClient: MLServiceClient;

    constructor() {
        this.imageProcessor = new ImageProcessor();
        this.dxfGenerator = new DXFGenerator();
        this.wallDetector = new WallDetector();
        this.mlServiceClient = new MLServiceClient();
        this.textDetector = new TextDetector(this.imageProcessor, this.mlServiceClient);
        this.dimensionDetector = new DimensionDetector();
        this.openingDetector = new OpeningDetector();
        this.furnitureDetector = new FurnitureDetector();
        this.roomDetector = new RoomDetector();
    }

    async process(imagePath: string): Promise<FloorPlan> {
        this.mlServiceClient.resetRunUsage();
        const imageBuffer = await this.imageProcessor.loadImage(imagePath);
        const analysis = await this.imageProcessor.prepareAnalysisImage(imageBuffer);
        const textElements = await this.textDetector.detect(imageBuffer);
        const maskedTextRegions = mergeBoundingBoxes(textElements.map((textElement) => textElement.boundingBox), 6);
        const segmentationRegions = await this.mlServiceClient.detectSegmentation(imageBuffer);
        const walls = await this.wallDetector.detect(
            analysis,
            maskedTextRegions,
            segmentationRegions ?? [],
        );
        const { dimensions, scaleResult } = this.dimensionDetector.detect(textElements, walls);
        const heuristicOpenings = this.openingDetector.detect(walls, analysis);
        const heuristicFurniture = this.furnitureDetector.detect(analysis, walls, textElements);
        const mlSymbols = await this.mlServiceClient.detectSymbols(imageBuffer);
        const openings = this.mergeOpenings(heuristicOpenings, mlSymbols?.openings ?? []);
        const furniture = this.mergeFurniture(heuristicFurniture, mlSymbols?.furniture ?? []);
        const rooms = this.roomDetector.detect(
            analysis.width,
            analysis.height,
            walls,
            textElements,
            scaleResult.scale,
            scaleResult.unit,
        );
        const linkedFurniture = this.assignFurnitureRooms(furniture, rooms);
        const junctionCount = this.countJunctions(walls);

        const metrics: ExtractionMetrics = {
            wallCount: walls.length,
            openingCount: openings.length,
            furnitureCount: linkedFurniture.length,
            dimensionCount: dimensions.length,
            textCount: textElements.length,
            roomCount: rooms.length,
            junctionCount,
            wallConfidence: this.averageConfidence(walls.map((wall) => wall.confidence)),
            textConfidence: this.averageConfidence(textElements.map((textElement) => textElement.confidence)),
            scaleConfidence: scaleResult.confidence,
            totalWallLength: walls.reduce((sum, wall) => (
                sum + Math.hypot(wall.endPoint.x - wall.startPoint.x, wall.endPoint.y - wall.startPoint.y)
            ), 0),
            averageWallThickness: this.averageConfidence(walls.map((wall) => wall.thickness)),
        };

        const floorPlan: FloorPlan = {
            id: uuidv4(),
            imagePath,
            width: analysis.width,
            height: analysis.height,
            scale: scaleResult.scale,
            unit: scaleResult.unit,
            walls,
            openings,
            furniture: linkedFurniture,
            dimensions,
            textElements,
            rooms,
            metrics,
            createdAt: new Date(),
            updatedAt: new Date(),
        };

        return floorPlan;
    }

    async getMLStatus(): Promise<MLStatus> {
        return this.mlServiceClient.getStatus();
    }

    generateDXF(floorPlan: FloorPlan): string {
        return this.dxfGenerator.generate(floorPlan);
    }

    private averageConfidence(values: number[]): number {
        if (!values.length) {
            return 0;
        }

        return values.reduce((sum, value) => sum + value, 0) / values.length;
    }

    private assignFurnitureRooms(furniture: FloorPlan['furniture'], rooms: FloorPlan['rooms']): FloorPlan['furniture'] {
        return furniture.map((item) => {
            const room = rooms.find((candidate) => (
                item.position.x >= candidate.boundingBox.x
                && item.position.x <= candidate.boundingBox.x + candidate.boundingBox.width
                && item.position.y >= candidate.boundingBox.y
                && item.position.y <= candidate.boundingBox.y + candidate.boundingBox.height
            ));

            return {
                ...item,
                roomId: room?.id,
            };
        });
    }

    private mergeOpenings(primary: FloorPlan['openings'], secondary: FloorPlan['openings']): FloorPlan['openings'] {
        const merged: FloorPlan['openings'] = [];
        const candidates = [...primary, ...secondary].sort((a, b) => b.confidence - a.confidence);

        for (const candidate of candidates) {
            const candidateBox = this.getOpeningBox(candidate);
            const duplicate = merged.some((existing) => {
                const existingBox = this.getOpeningBox(existing);
                const sameWall = candidate.wallId && existing.wallId && candidate.wallId === existing.wallId;
                const nearby = Math.abs(candidate.position.x - existing.position.x) <= Math.max(candidate.width, existing.width) * 0.4
                    && Math.abs(candidate.position.y - existing.position.y) <= Math.max(candidate.height, existing.height) * 0.4;

                return boxesOverlap(candidateBox, existingBox) || (sameWall && nearby);
            });

            if (!duplicate) {
                merged.push(candidate);
            }
        }

        return merged;
    }

    private mergeFurniture(primary: FloorPlan['furniture'], secondary: FloorPlan['furniture']): FloorPlan['furniture'] {
        const merged: FloorPlan['furniture'] = [];
        const candidates = [...primary, ...secondary].sort((a, b) => b.confidence - a.confidence);

        for (const candidate of candidates) {
            const candidateBox = this.getFurnitureBox(candidate);
            const duplicate = merged.some((existing) => {
                const existingBox = this.getFurnitureBox(existing);
                const nearby = Math.abs(candidate.position.x - existing.position.x) <= Math.max(candidate.width, existing.width) * 0.35
                    && Math.abs(candidate.position.y - existing.position.y) <= Math.max(candidate.depth, existing.depth) * 0.35;

                return boxesOverlap(candidateBox, existingBox) || (candidate.type === existing.type && nearby);
            });

            if (!duplicate) {
                merged.push(candidate);
            }
        }

        return merged;
    }

    private getOpeningBox(opening: FloorPlan['openings'][number]): { x: number; y: number; width: number; height: number } {
        if (opening.boundingBox) {
            return opening.boundingBox;
        }

        return {
            x: opening.position.x - opening.width / 2,
            y: opening.position.y - opening.height / 2,
            width: Math.max(1, opening.width),
            height: Math.max(1, opening.height),
        };
    }

    private getFurnitureBox(item: FloorPlan['furniture'][number]): { x: number; y: number; width: number; height: number } {
        if (item.boundingBox) {
            return item.boundingBox;
        }

        return {
            x: item.position.x - item.width / 2,
            y: item.position.y - item.depth / 2,
            width: Math.max(1, item.width),
            height: Math.max(1, item.depth),
        };
    }

    private countJunctions(walls: FloorPlan['walls']): number {
        const horizontalWalls = walls.filter((wall) => wall.orientation === 'horizontal');
        const verticalWalls = walls.filter((wall) => wall.orientation === 'vertical');
        let junctions = 0;

        for (const horizontalWall of horizontalWalls) {
            const minX = Math.min(horizontalWall.startPoint.x, horizontalWall.endPoint.x);
            const maxX = Math.max(horizontalWall.startPoint.x, horizontalWall.endPoint.x);
            const y = horizontalWall.startPoint.y;

            for (const verticalWall of verticalWalls) {
                const x = verticalWall.startPoint.x;
                const minY = Math.min(verticalWall.startPoint.y, verticalWall.endPoint.y);
                const maxY = Math.max(verticalWall.startPoint.y, verticalWall.endPoint.y);

                if (x >= minX && x <= maxX && y >= minY && y <= maxY) {
                    junctions += 1;
                }
            }
        }

        return junctions;
    }
}
