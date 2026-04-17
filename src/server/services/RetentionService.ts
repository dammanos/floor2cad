import { promises as fs } from 'fs';
import path from 'path';

export interface RetentionConfig {
    directories: string[];
    maxAgeMs: number;
    intervalMs: number;
}

export class RetentionService {
    private timer: NodeJS.Timeout | null = null;

    constructor(private readonly config: RetentionConfig) {}

    start(): void {
        if (this.config.maxAgeMs <= 0 || this.config.intervalMs <= 0) {
            return;
        }
        if (this.timer) {
            return;
        }
        const tick = () => {
            this.sweep().catch((error) => console.warn('Retention sweep failed:', error));
        };
        this.timer = setInterval(tick, this.config.intervalMs);
        if (typeof this.timer.unref === 'function') {
            this.timer.unref();
        }
        tick();
    }

    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    private async sweep(): Promise<void> {
        const threshold = Date.now() - this.config.maxAgeMs;
        for (const dir of this.config.directories) {
            await this.sweepDirectory(dir, threshold);
        }
    }

    private async sweepDirectory(dir: string, threshold: number): Promise<void> {
        let entries: string[];
        try {
            entries = await fs.readdir(dir);
        } catch {
            return;
        }

        for (const entry of entries) {
            const entryPath = path.join(dir, entry);
            try {
                const stats = await fs.stat(entryPath);
                if (stats.isDirectory()) continue;
                if (stats.mtimeMs < threshold) {
                    await fs.unlink(entryPath);
                }
            } catch {
                // Ignore — file may have been removed concurrently.
            }
        }
    }
}
