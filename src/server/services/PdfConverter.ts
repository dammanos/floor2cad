import { fromPath } from 'pdf2pic';
import path from 'path';
import { promises as fs } from 'fs';

export class PdfConverter {
    private readonly dpi: number;

    constructor(dpi = 400) {
        this.dpi = dpi;
    }

    /**
     * Render the first page of a PDF to a PNG file at high DPI.
     * Returns the path to the generated PNG.
     */
    async renderPage(pdfPath: string, outputDir: string, fileId: string): Promise<string> {
        const outputFilename = `${fileId}.png`;
        const outputPath = path.join(outputDir, outputFilename);

        const converter = fromPath(pdfPath, {
            density: this.dpi,
            saveFilename: fileId,
            savePath: outputDir,
            format: 'png',
            width: undefined,
            height: undefined,
        });

        const result = await converter(1, { responseType: 'image' });

        if (!result || !result.path) {
            throw new Error('PDF rendering produced no output');
        }

        // pdf2pic may save with a different name pattern (e.g., fileId.1.png)
        // Rename to our expected fileId.png if needed
        const generatedPath = result.path;
        if (generatedPath !== outputPath) {
            try {
                await fs.access(generatedPath);
                await fs.rename(generatedPath, outputPath);
            } catch {
                // If the file is already where we expect, that's fine
                await fs.access(outputPath);
            }
        }

        console.log(`PDF rendered to PNG: ${outputPath} (${this.dpi} DPI)`);
        return outputPath;
    }
}
