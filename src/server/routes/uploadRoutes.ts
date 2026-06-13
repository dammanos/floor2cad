import express, { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import { promises as fs } from 'fs';
import { v4 as uuidv4 } from 'uuid';

const router = Router();
const uploadDir = path.resolve(process.cwd(), process.env.UPLOAD_DIR || 'uploads');
const maxFileSize = Number(process.env.MAX_FILE_SIZE || 50_000_000);
const allowedFileTypes = new Map<string, string[]>([
    ['.png', ['image/png']],
    ['.jpg', ['image/jpeg']],
    ['.jpeg', ['image/jpeg']],
    ['.pdf', ['application/pdf']],
]);

const createUploadValidationError = (message: string) => {
    const error = new Error(message) as Error & { status?: number };
    error.status = 400;
    return error;
};

const formatBytes = (value: number): string => {
    if (value < 1024) {
        return `${value} B`;
    }

    if (value < 1024 * 1024) {
        return `${(value / 1024).toFixed(1)} KB`;
    }

    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
};

const upload = multer({
    dest: uploadDir,
    limits: {
        fileSize: maxFileSize,
    },
    fileFilter: (_req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();

        const allowedMimeTypes = allowedFileTypes.get(ext);
        if (allowedMimeTypes && allowedMimeTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(createUploadValidationError('Unsupported file type. Please upload a PNG or JPEG floor plan.'));
        }
    },
});

router.post('/upload', (req: Request, res: Response, next) => {
    upload.single('file')(req, res, (err: unknown) => {
        if (err instanceof multer.MulterError) {
            if (err.code === 'LIMIT_FILE_SIZE') {
                res.status(400).json({
                    error: `File is too large. Maximum allowed size is ${formatBytes(maxFileSize)}.`,
                });
                return;
            }

            res.status(400).json({ error: 'Upload error: ' + err.message });
            return;
        }

        if (err instanceof Error) {
            res.status(400).json({ error: err.message || 'Upload error' });
            return;
        }

        next();
    });
}, async (req: Request, res: Response) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded or invalid file type' });
        }

        const fileId = uuidv4();
        const ext = path.extname(req.file.originalname).toLowerCase();
        const newPath = path.join(uploadDir, `${fileId}${ext}`);

        await fs.rename(req.file.path, newPath);

        // PDFs are kept as-is. Conversion decides per-file: a vector PDF is read
        // directly (fast path); a scanned PDF is rasterized then run through CV.

        res.json({
            success: true,
            fileId,
            filename: req.file.originalname,
            size: req.file.size,
        });
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: 'Upload failed' });
    }
});

export default router;
