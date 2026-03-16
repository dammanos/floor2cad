import axios, { AxiosInstance } from 'axios';
import { BoundingBox, Furniture, MLStatus, MLSegmentationRegion, Opening, TextElement } from '../../shared/types';
import { v4 as uuidv4 } from 'uuid';

interface MLOcrResponse {
    textElements?: Array<Partial<TextElement> & {
        text: string;
        confidence: number;
        boundingBox: BoundingBox;
    }>;
}

interface MLSymbolPrediction {
    label: string;
    confidence: number;
    boundingBox: BoundingBox;
    angle?: number;
}

interface MLSymbolResponse {
    predictions?: MLSymbolPrediction[];
}

interface MLSegmentationResponse {
    regions?: MLSegmentationRegion[];
}

interface MLHealthResponse {
    ocr?: { enabled?: boolean; backendInstalled?: boolean };
    symbols?: { enabled?: boolean; backendInstalled?: boolean; modelPath?: string };
    segmentation?: { enabled?: boolean; backendInstalled?: boolean; model?: string };
}

const OPENING_LABELS = new Set<Opening['type']>([
    'door',
    'window',
    'pocket_door',
    'sliding_door',
    'double_door',
]);

export class MLServiceClient {
    private readonly httpClient?: AxiosInstance;
    private readonly serviceUrl?: string;
    private readonly ocrEnabled: boolean;
    private readonly symbolsEnabled: boolean;
    private readonly segmentationEnabled: boolean;
    private readonly runUsage = {
        ocr: false,
        symbols: false,
        segmentation: false,
    };

    constructor() {
        const baseURL = process.env.ML_SERVICE_URL?.trim();
        const timeout = Number(process.env.ML_SERVICE_TIMEOUT_MS || 12000);
        this.serviceUrl = baseURL;
        this.httpClient = baseURL
            ? axios.create({
                baseURL,
                timeout: Number.isFinite(timeout) ? timeout : 12000,
            })
            : undefined;
        this.ocrEnabled = this.parseBoolean(process.env.ML_OCR_ENABLED, Boolean(baseURL));
        this.symbolsEnabled = this.parseBoolean(process.env.ML_SYMBOLS_ENABLED, Boolean(baseURL));
        this.segmentationEnabled = this.parseBoolean(process.env.ML_SEGMENTATION_ENABLED, false);
    }

    resetRunUsage(): void {
        this.runUsage.ocr = false;
        this.runUsage.symbols = false;
        this.runUsage.segmentation = false;
    }

    async detectText(imageBuffer: Buffer): Promise<TextElement[] | null> {
        if (!this.httpClient || !this.ocrEnabled) {
            return null;
        }

        try {
            const { data } = await this.httpClient.post<MLOcrResponse>('/ocr', {
                imageBase64: imageBuffer.toString('base64'),
            });

            const textElements = (data.textElements ?? [])
                .map((element) => this.toTextElement(element))
                .filter((element): element is TextElement => Boolean(element));

            if (textElements.length > 0) {
                this.runUsage.ocr = true;
            }

            return textElements;
        } catch (error) {
            console.warn('ML OCR unavailable, falling back to Tesseract:', this.formatError(error));
            return null;
        }
    }

    async detectSymbols(imageBuffer: Buffer): Promise<{ openings: Opening[]; furniture: Furniture[] } | null> {
        if (!this.httpClient || !this.symbolsEnabled) {
            return null;
        }

        try {
            const { data } = await this.httpClient.post<MLSymbolResponse>('/detect-symbols', {
                imageBase64: imageBuffer.toString('base64'),
            });

            const openings: Opening[] = [];
            const furniture: Furniture[] = [];

            for (const prediction of data.predictions ?? []) {
                const normalizedLabel = this.normalizeLabel(prediction.label);
                if (OPENING_LABELS.has(normalizedLabel as Opening['type'])) {
                    openings.push(this.toOpening(prediction, normalizedLabel as Opening['type']));
                    continue;
                }

                furniture.push(this.toFurniture(prediction, normalizedLabel));
            }

            if (openings.length > 0 || furniture.length > 0) {
                this.runUsage.symbols = true;
            }

            return { openings, furniture };
        } catch (error) {
            console.warn('ML symbol detection unavailable, falling back to heuristics:', this.formatError(error));
            return null;
        }
    }

    async detectSegmentation(imageBuffer: Buffer): Promise<MLSegmentationRegion[] | null> {
        if (!this.httpClient || !this.segmentationEnabled) {
            return null;
        }

        try {
            const { data } = await this.httpClient.post<MLSegmentationResponse>('/segment', {
                imageBase64: imageBuffer.toString('base64'),
            });

            const regions = (data.regions ?? [])
                .map((region) => ({
                    label: region.label,
                    coverage: Math.max(0, Math.min(1, region.coverage)),
                    boundingBox: this.normalizeBox(region.boundingBox),
                }))
                .filter((region) => Boolean(region.label));

            if (regions.length > 0) {
                this.runUsage.segmentation = true;
            }

            return regions;
        } catch (error) {
            console.warn('ML segmentation unavailable, falling back to heuristics:', this.formatError(error));
            return null;
        }
    }

    async getStatus(): Promise<MLStatus> {
        const defaultStatus: MLStatus = {
            serviceUrl: this.serviceUrl,
            reachable: false,
            ocr: this.buildFeatureStatus(this.ocrEnabled, false, this.runUsage.ocr),
            symbols: this.buildFeatureStatus(this.symbolsEnabled, false, this.runUsage.symbols),
            segmentation: this.buildFeatureStatus(this.segmentationEnabled, false, this.runUsage.segmentation),
        };

        if (!this.httpClient) {
            return defaultStatus;
        }

        try {
            const { data } = await this.httpClient.get<MLHealthResponse>('/health');
            return {
                serviceUrl: this.serviceUrl,
                reachable: true,
                ocr: this.buildFeatureStatus(
                    this.ocrEnabled,
                    Boolean(data.ocr?.backendInstalled) && data.ocr?.enabled !== false,
                    this.runUsage.ocr,
                    data.ocr?.enabled === false ? 'Disabled in ML service' : undefined,
                ),
                symbols: this.buildFeatureStatus(
                    this.symbolsEnabled,
                    Boolean(data.symbols?.backendInstalled) && data.symbols?.enabled !== false,
                    this.runUsage.symbols,
                    data.symbols?.enabled === false ? 'Disabled in ML service' : data.symbols?.modelPath || undefined,
                ),
                segmentation: this.buildFeatureStatus(
                    this.segmentationEnabled,
                    Boolean(data.segmentation?.backendInstalled) && data.segmentation?.enabled !== false,
                    this.runUsage.segmentation,
                    data.segmentation?.enabled === false ? 'Disabled in ML service' : data.segmentation?.model || undefined,
                ),
            };
        } catch (error) {
            return {
                ...defaultStatus,
                ocr: { ...defaultStatus.ocr, detail: this.formatError(error) },
                symbols: { ...defaultStatus.symbols, detail: this.formatError(error) },
                segmentation: { ...defaultStatus.segmentation, detail: this.formatError(error) },
            };
        }
    }

    private toTextElement(element: Partial<TextElement> & { text: string; confidence: number; boundingBox: BoundingBox }): TextElement | null {
        if (!element.text || !element.boundingBox) {
            return null;
        }

        const boundingBox = this.normalizeBox(element.boundingBox);

        return {
            x: typeof element.x === 'number' ? element.x : boundingBox.x + boundingBox.width / 2,
            y: typeof element.y === 'number' ? element.y : boundingBox.y + boundingBox.height / 2,
            text: element.text.trim(),
            confidence: Math.max(0, Math.min(1, element.confidence ?? 0)),
            boundingBox,
            angle: typeof element.angle === 'number' ? element.angle : 0,
            category: this.normalizeCategory(element.category),
        };
    }

    private toOpening(prediction: MLSymbolPrediction, type: Opening['type']): Opening {
        const boundingBox = this.normalizeBox(prediction.boundingBox);

        return {
            id: uuidv4(),
            position: {
                x: boundingBox.x + boundingBox.width / 2,
                y: boundingBox.y + boundingBox.height / 2,
            },
            type,
            width: boundingBox.width,
            height: boundingBox.height,
            angle: prediction.angle ?? 0,
            confidence: Math.max(0, Math.min(1, prediction.confidence)),
            boundingBox,
        };
    }

    private toFurniture(prediction: MLSymbolPrediction, type: string): Furniture {
        const boundingBox = this.normalizeBox(prediction.boundingBox);

        return {
            id: uuidv4(),
            position: {
                x: boundingBox.x + boundingBox.width / 2,
                y: boundingBox.y + boundingBox.height / 2,
            },
            type,
            width: boundingBox.width,
            depth: boundingBox.height,
            angle: prediction.angle ?? 0,
            confidence: Math.max(0, Math.min(1, prediction.confidence)),
            label: type,
            boundingBox,
        };
    }

    private normalizeLabel(label: string): string {
        return label
            .trim()
            .toLowerCase()
            .replace(/[\s-]+/g, '_');
    }

    private normalizeCategory(category: TextElement['category'] | string | undefined): TextElement['category'] {
        if (category === 'dimension' || category === 'room' || category === 'label' || category === 'note') {
            return category;
        }

        return 'unknown';
    }

    private normalizeBox(box: BoundingBox): BoundingBox {
        return {
            x: Math.round(box.x),
            y: Math.round(box.y),
            width: Math.max(1, Math.round(box.width)),
            height: Math.max(1, Math.round(box.height)),
        };
    }

    private buildFeatureStatus(enabled: boolean, available: boolean, used: boolean, detail?: string) {
        return {
            enabled,
            configured: Boolean(this.httpClient) && enabled,
            available: Boolean(this.httpClient) && enabled && available,
            used,
            detail,
        };
    }

    private parseBoolean(value: string | undefined, fallback: boolean): boolean {
        if (value === undefined) {
            return fallback;
        }

        return /^(1|true|yes|on)$/i.test(value.trim());
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
