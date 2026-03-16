import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { promises as fs } from 'fs';
import path from 'path';
import uploadRoutes from './routes/uploadRoutes';
import conversionRoutes from './routes/conversionRoutes';
import { MLServiceClient } from './services/MLServiceClient';

const app = express();
const PORT = process.env.PORT || 5001;
const projectRoot = process.cwd();
const clientBuildPath = path.resolve(projectRoot, 'build');
const uploadsDir = path.resolve(projectRoot, process.env.UPLOAD_DIR || 'uploads');
const outputsDir = path.resolve(projectRoot, process.env.OUTPUT_DIR || 'outputs');
const mlServiceClient = new MLServiceClient();

type HttpError = Error & {
    status?: number;
};

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(clientBuildPath));

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
    app.listen(PORT, () => {
        console.log(`🚀 Server running on http://localhost:${PORT}`);
    });
};

start().catch(console.error);

export default app;
