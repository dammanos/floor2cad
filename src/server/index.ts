import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { promises as fs } from 'fs';
import path from 'path';
import uploadRoutes from './routes/uploadRoutes';
import conversionRoutes from './routes/conversionRoutes';
import { MLServiceClient } from './services/MLServiceClient';
import { RetentionService } from './services/RetentionService';

const app = express();
const PORT = process.env.PORT || 5001;
const CLIENT_PORT = process.env.CLIENT_PORT || 3000;
const projectRoot = process.cwd();
const clientBuildPath = path.resolve(projectRoot, 'build');
const uploadsDir = path.resolve(projectRoot, process.env.UPLOAD_DIR || 'uploads');
const outputsDir = path.resolve(projectRoot, process.env.OUTPUT_DIR || 'outputs');
const mlServiceClient = new MLServiceClient();

type HttpError = Error & {
    status?: number;
};

// ── CORS (locked to configured origins) ──────────────────────────────
const defaultOrigin = `http://localhost:${CLIENT_PORT}`;
const allowedOrigins = (process.env.CORS_ORIGINS || defaultOrigin)
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

app.use(cors({
    origin(origin, callback) {
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
            return;
        }
        callback(new Error(`Origin ${origin} is not allowed by CORS policy`));
    },
    credentials: true,
}));

app.use(express.json({ limit: '1mb' }));
app.use(express.static(clientBuildPath));

// ── Rate limiting for write-heavy endpoints ──────────────────────────
const windowMs = Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000);
const rateLimitMax = Number(process.env.RATE_LIMIT_MAX || 30);
const apiLimiter = rateLimit({
    windowMs: Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 60_000,
    max: Number.isFinite(rateLimitMax) && rateLimitMax > 0 ? rateLimitMax : 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests. Please slow down and try again shortly.' },
});

// Create directories
const createDirectories = async () => {
    const dirs = [uploadsDir, outputsDir];
    for (const dir of dirs) {
        try {
            await fs.mkdir(dir, { recursive: true });
        } catch (error) {
            console.error(`Failed to create ${dir}:`, error);
        }
    }
};

// Routes
app.use('/api/upload', apiLimiter);
app.use('/api/convert', apiLimiter);
app.use('/api', uploadRoutes);
app.use('/api', conversionRoutes);

// Health check
app.get('/api/health', async (req, res) => {
    const mlStatus = await mlServiceClient.getStatus();
    res.json({ status: 'OK', timestamp: new Date().toISOString(), mlStatus });
});

app.get('*', async (req, res, next) => {
    if (req.path.startsWith('/api')) {
        return next();
    }

    try {
        await fs.access(path.join(clientBuildPath, 'index.html'));
        return res.sendFile(path.join(clientBuildPath, 'index.html'));
    } catch {
        return next();
    }
});

// Global error handler
app.use((err: HttpError, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error('Unhandled error:', err);
    res.status(err.status || 500).json({
        error: err.message || 'Internal server error',
        details: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
});

// Start server
const start = async () => {
    await createDirectories();

    const retentionMinutes = Number(process.env.FILE_RETENTION_MINUTES ?? 120);
    const retentionIntervalMinutes = Number(process.env.FILE_RETENTION_INTERVAL_MINUTES ?? 15);
    if (Number.isFinite(retentionMinutes) && retentionMinutes > 0) {
        const retention = new RetentionService({
            directories: [uploadsDir, outputsDir],
            maxAgeMs: retentionMinutes * 60_000,
            intervalMs: Math.max(1, retentionIntervalMinutes) * 60_000,
        });
        retention.start();
    }

    app.listen(PORT, () => {
        console.log(`🚀 Server running on http://localhost:${PORT}`);
        console.log(`CORS allowed origins: ${allowedOrigins.join(', ')}`);
    });
};

start().catch(console.error);

export default app;
