import axios, { AxiosInstance } from 'axios';
import { BoundingBox, FloorPlan, Point, Opening, Room, TextElement, Wall } from '../../shared/types';
import { v4 as uuidv4 } from 'uuid';

interface PointDTO {
    x: number;
    y: number;
}

interface WallSegmentDTO {
    startPoint: PointDTO;
    endPoint: PointDTO;
    thickness: number;
    confidence: number;
    orientation: 'horizontal' | 'vertical' | 'diagonal';
}

interface OpeningSeedDTO {
    position: PointDTO;
    width: number;
    height: number;
    type: string;
    confidence: number;
    wallIndex?: number | null;
}

interface JunctionDTO {
    position: PointDTO;
    wallIndices: number[];
}

interface RoomDTO {
    boundary: PointDTO[];
    area: number;
    centroid: PointDTO;
}

interface RectifyResponse {
    imageBase64: string;
    width: number;
    height: number;
    angle: number;
    perspectiveApplied: boolean;
    deskewApplied: boolean;
}

interface VectorizeResponse {
    walls: WallSegmentDTO[];
    width: number;
    height: number;
}

interface SolveResponse {
    walls: WallSegmentDTO[];
    openings: OpeningSeedDTO[];
    junctions: JunctionDTO[];
    rooms: RoomDTO[];
}

interface ExportDxfResponse {
    dxf: string;
}

export interface MLPipelineResult {
    dxfContent: string;
    floorPlan: FloorPlan;
    rectification: {
        angle: number;
        perspectiveApplied: boolean;
        deskewApplied: boolean;
    };
}

interface ExportDxfRequest {
    width: number;
    height: number;
    scale: number;
    unit: string;
    walls: Array<{ startPoint: PointDTO; endPoint: PointDTO; thickness: number }>;
    openings: Array<{ position: PointDTO; width: number; height: number; angle: number; type: string }>;
    dimensions: Array<{ startPoint: PointDTO; endPoint: PointDTO; value: number; unit: string }>;
    texts: Array<{ position: PointDTO; text: string; height: number; angle?: number }>;
    rooms: Array<{ boundary: PointDTO[]; name?: string; centroid?: PointDTO }>;
}

export class MLServicePipeline {
    private readonly client?: AxiosInstance;

    constructor() {
        const baseURL = process.env.ML_SERVICE_URL?.trim();
        if (!baseURL) {
            return;
        }
        const timeout = Number(process.env.ML_SERVICE_TIMEOUT_MS || 60000);
        this.client = axios.create({
            baseURL,
            timeout: Number.isFinite(timeout) ? timeout : 60000,
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
        });
    }

    get available(): boolean {
        return Boolean(this.client);
    }

    async rectify(imageBuffer: Buffer): Promise<{ buffer: Buffer; meta: RectifyResponse } | null> {
        if (!this.client) return null;
        try {
            const { data } = await this.client.post<RectifyResponse>('/rectify', {
                imageBase64: imageBuffer.toString('base64'),
            });
            return { buffer: Buffer.from(data.imageBase64, 'base64'), meta: data };
        } catch (error) {
            console.warn('ML /rectify unavailable:', this.formatError(error));
            return null;
        }
    }

    async vectorize(imageBuffer: Buffer, downsample?: number): Promise<VectorizeResponse | null> {
        if (!this.client) return null;
        try {
            const payload: { imageBase64: string; downsample?: number } = {
                imageBase64: imageBuffer.toString('base64'),
            };
            if (downsample) {
                payload.downsample = downsample;
            }
            const { data } = await this.client.post<VectorizeResponse>('/vectorize', payload);
            return data;
        } catch (error) {
            console.warn('ML /vectorize unavailable:', this.formatError(error));
            return null;
        }
    }

    async solve(
        width: number,
        height: number,
        walls: WallSegmentDTO[],
        openings: OpeningSeedDTO[],
    ): Promise<SolveResponse | null> {
        if (!this.client) return null;
        try {
            const { data } = await this.client.post<SolveResponse>('/solve', {
                width,
                height,
                walls,
                openings,
            });
            return data;
        } catch (error) {
            console.warn('ML /solve unavailable:', this.formatError(error));
            return null;
        }
    }

    async exportDxf(request: ExportDxfRequest): Promise<string | null> {
        if (!this.client) return null;
        try {
            const { data } = await this.client.post<ExportDxfResponse>('/export-dxf', request);
            return data.dxf;
        } catch (error) {
            console.warn('ML /export-dxf unavailable:', this.formatError(error));
            return null;
        }
    }

    private formatError(error: unknown): string {
        if (axios.isAxiosError(error)) {
            return `${error.message}${error.response ? ` (${error.response.status})` : ''}`;
        }
        if (error instanceof Error) {
            return error.message;
        }
        return 'unknown error';
    }
}

export function wallSegmentFromDto(dto: WallSegmentDTO): Wall {
    return {
        id: uuidv4(),
        startPoint: { x: dto.startPoint.x, y: dto.startPoint.y },
        endPoint: { x: dto.endPoint.x, y: dto.endPoint.y },
        thickness: Math.max(2, Math.round(dto.thickness)),
        height: 3,
        confidence: Math.max(0, Math.min(1, dto.confidence)),
        orientation: dto.orientation,
    };
}

export function openingFromDto(dto: OpeningSeedDTO, walls: Wall[]): Opening {
    const width = Math.max(1, dto.width);
    const height = Math.max(1, dto.height);
    const wallId = dto.wallIndex != null && dto.wallIndex >= 0 && dto.wallIndex < walls.length
        ? walls[dto.wallIndex].id
        : undefined;
    const boundingBox: BoundingBox = {
        x: dto.position.x - width / 2,
        y: dto.position.y - height / 2,
        width,
        height,
    };
    return {
        id: uuidv4(),
        position: { x: dto.position.x, y: dto.position.y },
        type: mapOpeningType(dto.type),
        width,
        height,
        angle: 0,
        confidence: Math.max(0, Math.min(1, dto.confidence)),
        wallId,
        boundingBox,
    };
}

function mapOpeningType(raw: string): Opening['type'] {
    const normalized = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (
        normalized === 'door'
        || normalized === 'window'
        || normalized === 'pocket_door'
        || normalized === 'sliding_door'
        || normalized === 'double_door'
    ) {
        return normalized;
    }
    return 'door';
}

export function roomFromDto(dto: RoomDTO, textElements: TextElement[]): Room {
    const boundary: Point[] = dto.boundary.map((point) => ({ x: point.x, y: point.y }));
    const xs = boundary.map((p) => p.x);
    const ys = boundary.map((p) => p.y);
    const boundingBox: BoundingBox = {
        x: Math.min(...xs),
        y: Math.min(...ys),
        width: Math.max(1, Math.max(...xs) - Math.min(...xs)),
        height: Math.max(1, Math.max(...ys) - Math.min(...ys)),
    };

    const label = textElements.find((textElement) => (
        textElement.category === 'room'
        && textElement.x >= boundingBox.x
        && textElement.x <= boundingBox.x + boundingBox.width
        && textElement.y >= boundingBox.y
        && textElement.y <= boundingBox.y + boundingBox.height
    ));

    return {
        id: uuidv4(),
        name: label?.text,
        boundary,
        centroid: { x: dto.centroid.x, y: dto.centroid.y },
        area: dto.area,
        confidence: 0.75,
        labelId: label?.text,
        boundingBox,
    };
}
