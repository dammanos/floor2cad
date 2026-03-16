export interface Point {
    x: number;
    y: number;
}

export interface BoundingBox {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface MLSegmentationRegion {
    label: string;
    coverage: number;
    boundingBox: BoundingBox;
}

export interface MLFeatureStatus {
    enabled: boolean;
    configured: boolean;
    available: boolean;
    used: boolean;
    detail?: string;
}

export interface MLStatus {
    serviceUrl?: string;
    reachable: boolean;
    ocr: MLFeatureStatus;
    symbols: MLFeatureStatus;
    segmentation: MLFeatureStatus;
}

export interface DebugArtifacts {
    directory: string;
    overlaySvg: string;
    summaryJson: string;
}

export type MeasurementUnit = 'px' | 'mm' | 'cm' | 'm' | 'in' | 'ft';

export interface Dimension {
    id: string;
    length: number;
    position: Point;
    value: number;
    unit: MeasurementUnit;
    confidence: number;
    startPoint?: Point;
    endPoint?: Point;
    sourceText?: string;
}

export interface Wall {
    id: string;
    startPoint: Point;
    endPoint: Point;
    thickness: number;
    height: number;
    confidence: number;
    orientation?: 'horizontal' | 'vertical' | 'diagonal';
}

export interface Opening {
    id: string;
    position: Point;
    type: 'door' | 'window' | 'pocket_door' | 'sliding_door' | 'double_door';
    width: number;
    height: number;
    angle: number;
    confidence: number;
    wallId?: string;
    boundingBox?: BoundingBox;
}

export interface Furniture {
    id: string;
    position: Point;
    type: string;
    width: number;
    depth: number;
    angle: number;
    confidence: number;
    label?: string;
    boundingBox?: BoundingBox;
    roomId?: string;
}

export interface Room {
    id: string;
    name?: string;
    boundary: Point[];
    centroid: Point;
    area: number;
    confidence: number;
    labelId?: string;
    boundingBox: BoundingBox;
}

export interface ExtractionMetrics {
    wallCount: number;
    openingCount: number;
    furnitureCount: number;
    dimensionCount: number;
    textCount: number;
    roomCount: number;
    junctionCount: number;
    wallConfidence: number;
    textConfidence: number;
    scaleConfidence: number;
    totalWallLength: number;
    averageWallThickness: number;
}

export interface FloorPlan {
    id: string;
    imagePath: string;
    width: number;
    height: number;
    scale: number;
    unit: MeasurementUnit;
    walls: Wall[];
    openings: Opening[];
    furniture: Furniture[];
    dimensions: Dimension[];
    textElements: TextElement[];
    rooms: Room[];
    metrics: ExtractionMetrics;
    createdAt: Date;
    updatedAt: Date;
}

export type SerializedFloorPlan = Omit<FloorPlan, 'createdAt' | 'updatedAt'> & {
    createdAt: string;
    updatedAt: string;
};

export interface TextElement {
    x: number;
    y: number;
    text: string;
    confidence: number;
    boundingBox: BoundingBox;
    angle: number;
    category: 'dimension' | 'room' | 'label' | 'note' | 'unknown';
}

export interface ConversionResult {
    success: boolean;
    floorPlanId: string;
    dxfContent: string;
    message?: string;
    error?: string;
}

export interface ConversionResponse {
    success: boolean;
    floorPlanId: string;
    dxfFile: string;
    data: SerializedFloorPlan;
    debugArtifacts?: DebugArtifacts;
    mlStatus?: MLStatus;
    message?: string;
    error?: string;
}

export interface UploadResponse {
    success: boolean;
    fileId: string;
    filename: string;
    size: number;
    message?: string;
    error?: string;
}
