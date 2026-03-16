import sharp from 'sharp';
import Tesseract from 'tesseract.js';
import { promises as fs } from 'fs';

export interface ColorChannels {
    red: Uint8ClampedArray;
    green: Uint8ClampedArray;
    blue: Uint8ClampedArray;
}

export interface AnalysisImageData {
    width: number;
    height: number;
    grayscale: Uint8ClampedArray;
    binary: Uint8ClampedArray;
    edges: Uint8ClampedArray;
    threshold: number;
    colorMasks?: {
        redLines: Uint8ClampedArray;
        blueLines: Uint8ClampedArray;
        greenLines: Uint8ClampedArray;
    };
}

export class ImageProcessor {
    async loadImage(filePath: string): Promise<Buffer> {
        return fs.readFile(filePath);
    }

    async prepareAnalysisImage(imageBuffer: Buffer): Promise<AnalysisImageData> {
        // Extract raw grayscale with denoising and sharpening
        const meta = await sharp(imageBuffer).metadata();
        const imgW = meta.width ?? 1;
        const imgH = meta.height ?? 1;
        const medianSize = Math.min(3, imgW, imgH);   // avoid window > image

        let pipeline = sharp(imageBuffer)
            .rotate()
            .grayscale()
            .normalize();
        if (medianSize >= 3) {
            pipeline = pipeline.median(medianSize);
        }
        const { data, info } = await pipeline
            .sharpen({ sigma: 1.0, m1: 1.5, m2: 0.7 })  // stronger sharpening
            .raw()
            .toBuffer({ resolveWithObject: true });

        const grayscale = new Uint8ClampedArray(data);

        // Apply CLAHE (Contrast Limited Adaptive Histogram Equalization)
        const enhanced = this.applyCLAHE(grayscale, info.width, info.height, 8, 3.0);

        const threshold = this.computeOtsuThreshold(enhanced);

        // Adaptive local threshold produces better results on scanned drawings
        const adaptiveBinary = this.adaptiveThreshold(enhanced, info.width, info.height, 31, 8);
        const binary = this.applyMorphology(adaptiveBinary, info.width, info.height);

        // Proper 3×3 Sobel with non-maximum suppression
        const edges = this.detectSobelEdges(enhanced, info.width, info.height);

        // Extract color channel masks for color-aware detection
        let colorMasks: AnalysisImageData['colorMasks'] | undefined;
        try {
            colorMasks = await this.extractColorMasks(imageBuffer, info.width, info.height);
        } catch {
            // Color extraction is optional; ignore failures
        }

        return {
            width: info.width,
            height: info.height,
            grayscale: enhanced,
            binary,
            edges,
            threshold,
            colorMasks,
        };
    }

    async convertToGrayscale(imageBuffer: Buffer): Promise<Buffer> {
        return sharp(imageBuffer)
            .rotate()
            .grayscale()
            .normalize()
            .toBuffer();
    }

    async resize(imageBuffer: Buffer, scale: number): Promise<Buffer> {
        const metadata = await sharp(imageBuffer).metadata();
        const width = metadata.width ? Math.floor(metadata.width * scale) : undefined;
        const height = metadata.height ? Math.floor(metadata.height * scale) : undefined;

        return sharp(imageBuffer)
            .resize(width, height)
            .toBuffer();
    }

    async extractText(imageBuffer: Buffer): Promise<string> {
        try {
            const result = await Tesseract.recognize(await this.createOCRBuffer(imageBuffer), 'eng');
            return result.data.text;
        } catch (error) {
            console.error('OCR Error:', error);
            return '';
        }
    }

    async createOCRBuffer(imageBuffer: Buffer): Promise<Buffer> {
        return sharp(imageBuffer)
            .rotate()
            .grayscale()
            .normalize()
            .linear(1.2, -12)
            .sharpen()
            .threshold(180)
            .png()
            .toBuffer();
    }

    async detectEdges(imageBuffer: Buffer): Promise<Buffer> {
        const analysis = await this.prepareAnalysisImage(imageBuffer);
        return Buffer.from(analysis.edges);
    }

    async getImageDimensions(imageBuffer: Buffer): Promise<{ width: number; height: number }> {
        const metadata = await sharp(imageBuffer).metadata();
        return {
            width: metadata.width || 0,
            height: metadata.height || 0,
        };
    }

    async saveImage(imageBuffer: Buffer, outputPath: string): Promise<void> {
        await fs.writeFile(outputPath, imageBuffer);
    }

    private computeOtsuThreshold(grayscale: Uint8ClampedArray): number {
        const histogram = new Array<number>(256).fill(0);
        for (const value of grayscale) {
            histogram[value] += 1;
        }

        const total = grayscale.length;
        let sum = 0;
        for (let index = 0; index < histogram.length; index += 1) {
            sum += index * histogram[index];
        }

        let sumBackground = 0;
        let weightBackground = 0;
        let maxVariance = 0;
        let threshold = 160;

        for (let index = 0; index < histogram.length; index += 1) {
            weightBackground += histogram[index];
            if (weightBackground === 0) {
                continue;
            }

            const weightForeground = total - weightBackground;
            if (weightForeground === 0) {
                break;
            }

            sumBackground += index * histogram[index];
            const meanBackground = sumBackground / weightBackground;
            const meanForeground = (sum - sumBackground) / weightForeground;
            const variance = weightBackground * weightForeground * Math.pow(meanBackground - meanForeground, 2);

            if (variance > maxVariance) {
                maxVariance = variance;
                threshold = index;
            }
        }

        return Math.max(90, Math.min(210, threshold));
    }

    private threshold(grayscale: Uint8ClampedArray, threshold: number): Uint8ClampedArray {
        const binary = new Uint8ClampedArray(grayscale.length);
        for (let index = 0; index < grayscale.length; index += 1) {
            binary[index] = grayscale[index] <= threshold ? 1 : 0;
        }
        return binary;
    }

    private applyMorphology(mask: Uint8ClampedArray, width: number, height: number): Uint8ClampedArray {
        const dilated = this.dilate(mask, width, height);
        return this.erode(dilated, width, height);
    }

    private dilate(mask: Uint8ClampedArray, width: number, height: number): Uint8ClampedArray {
        const output = new Uint8ClampedArray(mask.length);
        for (let y = 0; y < height; y += 1) {
            for (let x = 0; x < width; x += 1) {
                let active = 0;
                for (let offsetY = -1; offsetY <= 1 && !active; offsetY += 1) {
                    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
                        const nextX = x + offsetX;
                        const nextY = y + offsetY;
                        if (nextX < 0 || nextX >= width || nextY < 0 || nextY >= height) {
                            continue;
                        }

                        if (mask[nextY * width + nextX]) {
                            active = 1;
                            break;
                        }
                    }
                }
                output[y * width + x] = active;
            }
        }
        return output;
    }

    private erode(mask: Uint8ClampedArray, width: number, height: number): Uint8ClampedArray {
        const output = new Uint8ClampedArray(mask.length);
        for (let y = 0; y < height; y += 1) {
            for (let x = 0; x < width; x += 1) {
                let active = 1;
                for (let offsetY = -1; offsetY <= 1 && active; offsetY += 1) {
                    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
                        const nextX = x + offsetX;
                        const nextY = y + offsetY;
                        if (nextX < 0 || nextX >= width || nextY < 0 || nextY >= height) {
                            active = 0;
                            break;
                        }

                        if (!mask[nextY * width + nextX]) {
                            active = 0;
                            break;
                        }
                    }
                }
                output[y * width + x] = active;
            }
        }
        return output;
    }

    private detectSobelEdges(grayscale: Uint8ClampedArray, width: number, height: number): Uint8ClampedArray {
        // Full 3×3 Sobel kernels
        const magnitude = new Float32Array(grayscale.length);
        const direction = new Float32Array(grayscale.length);
        let maxMag = 0;

        for (let y = 1; y < height - 1; y += 1) {
            for (let x = 1; x < width - 1; x += 1) {
                const idx = y * width + x;
                // Sobel X kernel
                const gx =
                    -grayscale[(y - 1) * width + (x - 1)] + grayscale[(y - 1) * width + (x + 1)]
                    - 2 * grayscale[y * width + (x - 1)] + 2 * grayscale[y * width + (x + 1)]
                    - grayscale[(y + 1) * width + (x - 1)] + grayscale[(y + 1) * width + (x + 1)];
                // Sobel Y kernel
                const gy =
                    -grayscale[(y - 1) * width + (x - 1)] - 2 * grayscale[(y - 1) * width + x] - grayscale[(y - 1) * width + (x + 1)]
                    + grayscale[(y + 1) * width + (x - 1)] + 2 * grayscale[(y + 1) * width + x] + grayscale[(y + 1) * width + (x + 1)];

                const mag = Math.sqrt(gx * gx + gy * gy);
                magnitude[idx] = mag;
                direction[idx] = Math.atan2(gy, gx);
                if (mag > maxMag) maxMag = mag;
            }
        }

        // Non-maximum suppression
        const edges = new Uint8ClampedArray(grayscale.length);
        const edgeThreshold = maxMag * 0.08;

        for (let y = 2; y < height - 2; y += 1) {
            for (let x = 2; x < width - 2; x += 1) {
                const idx = y * width + x;
                const mag = magnitude[idx];
                if (mag < edgeThreshold) continue;

                // Quantize direction to 4 zones
                let angle = ((direction[idx] * 180 / Math.PI) + 180) % 180;
                let dx1 = 0, dy1 = 0;
                if (angle < 22.5 || angle >= 157.5) { dx1 = 1; dy1 = 0; }
                else if (angle < 67.5) { dx1 = 1; dy1 = 1; }
                else if (angle < 112.5) { dx1 = 0; dy1 = 1; }
                else { dx1 = -1; dy1 = 1; }

                const neighbor1 = magnitude[(y + dy1) * width + (x + dx1)];
                const neighbor2 = magnitude[(y - dy1) * width + (x - dx1)];

                edges[idx] = mag >= neighbor1 && mag >= neighbor2 ? 1 : 0;
            }
        }

        return edges;
    }

    /**
     * Contrast Limited Adaptive Histogram Equalization (CLAHE)
     * Improves local contrast for scanned drawings with uneven lighting
     */
    private applyCLAHE(
        grayscale: Uint8ClampedArray,
        width: number,
        height: number,
        tileCount: number,
        clipLimit: number,
    ): Uint8ClampedArray {
        const output = new Uint8ClampedArray(grayscale.length);
        const tileW = Math.ceil(width / tileCount);
        const tileH = Math.ceil(height / tileCount);

        // Build a lookup table per tile
        const tileLUTs: Uint8Array[][] = [];
        for (let ty = 0; ty < tileCount; ty += 1) {
            tileLUTs[ty] = [];
            for (let tx = 0; tx < tileCount; tx += 1) {
                const startX = tx * tileW;
                const startY = ty * tileH;
                const endX = Math.min(startX + tileW, width);
                const endY = Math.min(startY + tileH, height);
                const tilePixels = (endX - startX) * (endY - startY);

                // Build histogram for this tile
                const hist = new Uint32Array(256);
                for (let y = startY; y < endY; y += 1) {
                    for (let x = startX; x < endX; x += 1) {
                        hist[grayscale[y * width + x]] += 1;
                    }
                }

                // Clip histogram
                const limit = Math.max(1, Math.floor(clipLimit * tilePixels / 256));
                let excess = 0;
                for (let i = 0; i < 256; i += 1) {
                    if (hist[i] > limit) {
                        excess += hist[i] - limit;
                        hist[i] = limit;
                    }
                }
                const bonus = Math.floor(excess / 256);
                for (let i = 0; i < 256; i += 1) {
                    hist[i] += bonus;
                }

                // Build CDF / LUT
                const lut = new Uint8Array(256);
                let cumulative = 0;
                for (let i = 0; i < 256; i += 1) {
                    cumulative += hist[i];
                    lut[i] = Math.round((cumulative / tilePixels) * 255);
                }
                tileLUTs[ty][tx] = lut;
            }
        }

        // Bilinear interpolation between tiles
        for (let y = 0; y < height; y += 1) {
            for (let x = 0; x < width; x += 1) {
                const idx = y * width + x;
                const val = grayscale[idx];

                const tx = Math.min(x / tileW, tileCount - 1);
                const ty2 = Math.min(y / tileH, tileCount - 1);
                const txI = Math.min(Math.floor(tx), tileCount - 1);
                const tyI = Math.min(Math.floor(ty2), tileCount - 1);
                const txI2 = Math.min(txI + 1, tileCount - 1);
                const tyI2 = Math.min(tyI + 1, tileCount - 1);
                const fx = tx - txI;
                const fy = ty2 - tyI;

                const tl = tileLUTs[tyI][txI][val];
                const tr = tileLUTs[tyI][txI2][val];
                const bl = tileLUTs[tyI2][txI][val];
                const br = tileLUTs[tyI2][txI2][val];

                output[idx] = Math.round(
                    tl * (1 - fx) * (1 - fy) +
                    tr * fx * (1 - fy) +
                    bl * (1 - fx) * fy +
                    br * fx * fy,
                );
            }
        }

        return output;
    }

    /**
     * Adaptive local thresholding — uses mean of a local window with a bias.
     * Much better than global Otsu for scanned documents with uneven lighting.
     */
    private adaptiveThreshold(
        grayscale: Uint8ClampedArray,
        width: number,
        height: number,
        windowSize: number,
        bias: number,
    ): Uint8ClampedArray {
        const binary = new Uint8ClampedArray(grayscale.length);
        const half = Math.floor(windowSize / 2);

        // Build integral image for fast local mean computation
        const integral = new Float64Array((width + 1) * (height + 1));
        for (let y = 0; y < height; y += 1) {
            let rowSum = 0;
            for (let x = 0; x < width; x += 1) {
                rowSum += grayscale[y * width + x];
                integral[(y + 1) * (width + 1) + (x + 1)] =
                    rowSum + integral[y * (width + 1) + (x + 1)];
            }
        }

        for (let y = 0; y < height; y += 1) {
            for (let x = 0; x < width; x += 1) {
                const x1 = Math.max(0, x - half);
                const y1 = Math.max(0, y - half);
                const x2 = Math.min(width - 1, x + half);
                const y2 = Math.min(height - 1, y + half);
                const area = (x2 - x1 + 1) * (y2 - y1 + 1);

                const sum =
                    integral[(y2 + 1) * (width + 1) + (x2 + 1)]
                    - integral[y1 * (width + 1) + (x2 + 1)]
                    - integral[(y2 + 1) * (width + 1) + x1]
                    + integral[y1 * (width + 1) + x1];

                const localMean = sum / area;
                binary[y * width + x] = grayscale[y * width + x] <= localMean - bias ? 1 : 0;
            }
        }

        return binary;
    }

    /**
     * Extract color-specific binary masks from the original color image.
     * Identifies red, blue, and green lines by analyzing HSV-like channels.
     */
    async extractColorMasks(
        imageBuffer: Buffer,
        targetWidth: number,
        targetHeight: number,
    ): Promise<{ redLines: Uint8ClampedArray; blueLines: Uint8ClampedArray; greenLines: Uint8ClampedArray }> {
        const { data, info } = await sharp(imageBuffer)
            .rotate()
            .resize(targetWidth, targetHeight, { fit: 'fill' })
            .removeAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });

        const pixels = data;
        const len = info.width * info.height;
        const redLines = new Uint8ClampedArray(len);
        const blueLines = new Uint8ClampedArray(len);
        const greenLines = new Uint8ClampedArray(len);

        for (let i = 0; i < len; i += 1) {
            const r = pixels[i * 3];
            const g = pixels[i * 3 + 1];
            const b = pixels[i * 3 + 2];

            const maxC = Math.max(r, g, b);
            const minC = Math.min(r, g, b);
            const sat = maxC > 0 ? (maxC - minC) / maxC : 0;

            // Only consider saturated, non-white, non-black pixels
            if (sat < 0.25 || maxC < 50 || minC > 200) continue;

            // Red dominant: R is max and significantly above G and B
            if (r === maxC && r > g + 40 && r > b + 40) {
                redLines[i] = 1;
            }
            // Blue dominant: B is max
            else if (b === maxC && b > r + 40 && b > g + 30) {
                blueLines[i] = 1;
            }
            // Green dominant: G is max
            else if (g === maxC && g > r + 30 && g > b + 30) {
                greenLines[i] = 1;
            }
        }

        return { redLines, blueLines, greenLines };
    }
}
