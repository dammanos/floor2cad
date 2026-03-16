import Tesseract from 'tesseract.js';
import { BoundingBox, TextElement } from '../../../shared/types';
import { ImageProcessor } from '../ImageProcessor';
import { MLServiceClient } from '../MLServiceClient';

interface OCRWord {
    text?: string;
    confidence?: number;
    bbox?: {
        x0: number;
        y0: number;
        x1: number;
        y1: number;
    };
}

const dimensionPattern = /(\d+(?:[.,]\d+)?)(?:\s?(mm|cm|m|ft|in|"|'))?/i;
const roomKeywords = /kitchen|bed|bath|living|hall|office|closet|wc|toilet|room|dining|laundry/i;

export class TextDetector {
    constructor(
        private readonly imageProcessor: ImageProcessor,
        private readonly mlServiceClient?: MLServiceClient,
    ) {}

    async detect(imageBuffer: Buffer): Promise<TextElement[]> {
        const mlText = await this.mlServiceClient?.detectText(imageBuffer);
        if (mlText !== null && mlText !== undefined) {
            return mlText;
        }

        try {
            const ocrBuffer = await this.imageProcessor.createOCRBuffer(imageBuffer);
            const result = await Tesseract.recognize(ocrBuffer, 'eng');
            const words = ((result.data as { words?: OCRWord[] }).words ?? [])
                .map((word) => this.toTextElement(word))
                .filter((word): word is TextElement => Boolean(word));

            return words;
        } catch (error) {
            console.error('Text detection failed:', error);
            return [];
        }
    }

    private toTextElement(word: OCRWord): TextElement | null {
        const rawText = word.text?.trim() || '';
        const confidence = (word.confidence ?? 0) / 100;
        const bbox = word.bbox;

        if (!rawText || confidence < 0.35 || !bbox) {
            return null;
        }

        const normalizedText = rawText.replace(/\s+/g, ' ');
        const boundingBox: BoundingBox = {
            x: bbox.x0,
            y: bbox.y0,
            width: Math.max(1, bbox.x1 - bbox.x0),
            height: Math.max(1, bbox.y1 - bbox.y0),
        };

        return {
            x: boundingBox.x + boundingBox.width / 2,
            y: boundingBox.y + boundingBox.height / 2,
            text: normalizedText,
            confidence,
            boundingBox,
            angle: boundingBox.width >= boundingBox.height ? 0 : 90,
            category: this.classify(normalizedText),
        };
    }

    private classify(text: string): TextElement['category'] {
        if (dimensionPattern.test(text)) {
            return 'dimension';
        }

        if (roomKeywords.test(text)) {
            return 'room';
        }

        if (/^[A-Za-z0-9\-\s]{2,}$/.test(text)) {
            return 'label';
        }

        return 'unknown';
    }
}
