import express, { Router, Request, Response } from 'express';
import { FloorPlanConverter } from '../services/FloorPlanConverter';
import { DebugArtifactService } from '../services/DebugArtifactService';
import { promises as fs } from 'fs';
import path from 'path';

const router = Router();
const converter = new FloorPlanConverter();
const debugArtifactService = new DebugArtifactService();
const uploadDir = path.resolve(process.cwd(), process.env.UPLOAD_DIR || 'uploads');
const outputDir = path.resolve(process.cwd(), process.env.OUTPUT_DIR || 'outputs');
const fileIdPattern = /^[0-9a-f-]{36}$/i;

const isValidFileId = (fileId: string): boolean => fileIdPattern.test(fileId);

router.post('/convert', async (req: Request, res: Response) => {
    try {
        const { fileId } = req.body;

        if (!fileId) {
            return res.status(400).json({ error: 'fileId is required' });
        }

        if (!isValidFileId(fileId)) {
            return res.status(400).json({ error: 'Invalid fileId format' });
        }
        
        // Ensure directory exists
        try {
            await fs.access(uploadDir);
        } catch {
            return res.status(404).json({ error: 'Upload directory not found' });
        }

        const files = await fs.readdir(uploadDir);
        const imagePath = files
            .filter(f => f.startsWith(fileId))
            .map(f => path.join(uploadDir, f))[0];

        if (!imagePath) {
            console.error(`File not found for fileId: ${fileId}, available files:`, files);
            return res.status(404).json({ error: 'File not found' });
        }

        console.log(`Converting file: ${imagePath}`);
        
        try {
            console.log('Starting floor plan conversion...');
            const { floorPlan, dxfContent, usedMLPipeline, rectification } = await converter.convert(imagePath);
            console.log(`Conversion complete (ML pipeline: ${usedMLPipeline})`);
            const mlStatus = await converter.getMLStatus();

            await fs.mkdir(outputDir, { recursive: true });

            const dxfPath = path.join(outputDir, `${fileId}.dxf`);
            await fs.writeFile(dxfPath, dxfContent);
            console.log('DXF file written successfully:', dxfPath);

            const debugArtifacts = await debugArtifactService.writeArtifacts(outputDir, floorPlan);

            res.json({
                success: true,
                floorPlanId: floorPlan.id,
                dxfFile: `${fileId}.dxf`,
                data: floorPlan,
                mlStatus,
                usedMLPipeline,
                rectification,
                debugArtifacts: {
                    directory: path.relative(process.cwd(), debugArtifacts.directory),
                    overlaySvg: path.relative(process.cwd(), debugArtifacts.overlaySvgPath),
                    summaryJson: path.relative(process.cwd(), debugArtifacts.summaryJsonPath),
                },
            });
        } catch (conversionError: any) {
            console.error('Conversion processing error:', conversionError);
            console.error('Error stack:', conversionError.stack);
            return res.status(500).json({ 
                error: conversionError.message || 'Conversion processing failed',
                details: process.env.NODE_ENV === 'development' ? conversionError.stack : undefined
            });
        }
    } catch (error: any) {
        console.error('Conversion route error:', error);
        console.error('Error stack:', error.stack);
        res.status(500).json({ 
            error: error.message || 'Conversion failed',
            details: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
});

router.get('/download/:fileId', async (req: Request, res: Response) => {
    try {
        const { fileId } = req.params;

        if (!isValidFileId(fileId)) {
            return res.status(400).json({ error: 'Invalid fileId format' });
        }

        const filePath = path.join(outputDir, `${fileId}.dxf`);

        await fs.access(filePath);

        res.download(filePath, `${fileId}.dxf`);
    } catch (error) {
        res.status(404).json({ error: 'File not found' });
    }
});

export default router;
