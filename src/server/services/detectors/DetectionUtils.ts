import { BoundingBox, Point, Wall } from '../../../shared/types';

export interface ConnectedComponent {
    area: number;
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    centroid: Point;
    touchesBorder: boolean;
    fillRatio: number;
}

export const clamp = (value: number, min: number, max: number): number => (
    Math.min(max, Math.max(min, value))
);

export const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

export const median = (values: number[]): number => {
    if (!values.length) {
        return 0;
    }

    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[middle - 1] + sorted[middle]) / 2
        : sorted[middle];
};

export const getIndex = (x: number, y: number, width: number): number => y * width + x;

export const boxesOverlap = (a: BoundingBox, b: BoundingBox): boolean => (
    a.x < b.x + b.width
    && a.x + a.width > b.x
    && a.y < b.y + b.height
    && a.y + a.height > b.y
);

export const pointInBoundingBox = (point: Point, box: BoundingBox): boolean => (
    point.x >= box.x
    && point.x <= box.x + box.width
    && point.y >= box.y
    && point.y <= box.y + box.height
);

export const findConnectedComponents = (
    mask: Uint8ClampedArray,
    width: number,
    height: number,
    minArea = 1,
): ConnectedComponent[] => {
    const visited = new Uint8Array(mask.length);
    const components: ConnectedComponent[] = [];
    const queueX = new Int32Array(mask.length);
    const queueY = new Int32Array(mask.length);

    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const startIndex = getIndex(x, y, width);
            if (visited[startIndex] || mask[startIndex] === 0) {
                continue;
            }

            let head = 0;
            let tail = 0;
            visited[startIndex] = 1;
            queueX[tail] = x;
            queueY[tail] = y;
            tail += 1;

            let area = 0;
            let sumX = 0;
            let sumY = 0;
            let minX = x;
            let maxX = x;
            let minY = y;
            let maxY = y;
            let touchesBorder = false;

            while (head < tail) {
                const currentX = queueX[head];
                const currentY = queueY[head];
                head += 1;

                area += 1;
                sumX += currentX;
                sumY += currentY;
                minX = Math.min(minX, currentX);
                maxX = Math.max(maxX, currentX);
                minY = Math.min(minY, currentY);
                maxY = Math.max(maxY, currentY);

                if (currentX === 0 || currentY === 0 || currentX === width - 1 || currentY === height - 1) {
                    touchesBorder = true;
                }

                const neighbors = [
                    [currentX + 1, currentY],
                    [currentX - 1, currentY],
                    [currentX, currentY + 1],
                    [currentX, currentY - 1],
                ];

                for (const [nextX, nextY] of neighbors) {
                    if (nextX < 0 || nextX >= width || nextY < 0 || nextY >= height) {
                        continue;
                    }

                    const nextIndex = getIndex(nextX, nextY, width);
                    if (visited[nextIndex] || mask[nextIndex] === 0) {
                        continue;
                    }

                    visited[nextIndex] = 1;
                    queueX[tail] = nextX;
                    queueY[tail] = nextY;
                    tail += 1;
                }
            }

            if (area >= minArea) {
                const boxArea = Math.max(1, (maxX - minX + 1) * (maxY - minY + 1));
                components.push({
                    area,
                    minX,
                    minY,
                    maxX,
                    maxY,
                    centroid: {
                        x: sumX / area,
                        y: sumY / area,
                    },
                    touchesBorder,
                    fillRatio: area / boxArea,
                });
            }
        }
    }

    return components;
};

export const drawBoundingBox = (
    mask: Uint8ClampedArray,
    width: number,
    height: number,
    box: BoundingBox,
    value = 1,
    padding = 0,
): void => {
    const startX = clamp(Math.floor(box.x) - padding, 0, width - 1);
    const endX = clamp(Math.ceil(box.x + box.width) + padding, 0, width - 1);
    const startY = clamp(Math.floor(box.y) - padding, 0, height - 1);
    const endY = clamp(Math.ceil(box.y + box.height) + padding, 0, height - 1);

    for (let y = startY; y <= endY; y += 1) {
        for (let x = startX; x <= endX; x += 1) {
            mask[getIndex(x, y, width)] = value;
        }
    }
};

export const cloneMask = (mask: Uint8ClampedArray): Uint8ClampedArray => new Uint8ClampedArray(mask);

export const maskBoundingBoxes = (
    sourceMask: Uint8ClampedArray,
    width: number,
    height: number,
    boxes: BoundingBox[],
    padding = 0,
): Uint8ClampedArray => {
    const mask = cloneMask(sourceMask);
    for (const box of boxes) {
        drawBoundingBox(mask, width, height, box, 0, padding);
    }

    return mask;
};

export const mergeBoundingBoxes = (boxes: BoundingBox[], padding = 0): BoundingBox[] => {
    const expanded = boxes.map((box) => ({
        x: box.x - padding,
        y: box.y - padding,
        width: box.width + padding * 2,
        height: box.height + padding * 2,
    }));

    const merged: BoundingBox[] = [];
    for (const box of expanded.sort((a, b) => a.x - b.x || a.y - b.y)) {
        const overlapping = merged.find((candidate) => boxesOverlap(candidate, box));
        if (!overlapping) {
            merged.push({ ...box });
            continue;
        }

        const minX = Math.min(overlapping.x, box.x);
        const minY = Math.min(overlapping.y, box.y);
        const maxX = Math.max(overlapping.x + overlapping.width, box.x + box.width);
        const maxY = Math.max(overlapping.y + overlapping.height, box.y + box.height);
        overlapping.x = minX;
        overlapping.y = minY;
        overlapping.width = maxX - minX;
        overlapping.height = maxY - minY;
    }

    return merged;
};

export const drawWallMask = (
    walls: Wall[],
    width: number,
    height: number,
    expand = 0,
): Uint8ClampedArray => {
    const mask = new Uint8ClampedArray(width * height);

    for (const wall of walls) {
        const dx = wall.endPoint.x - wall.startPoint.x;
        const dy = wall.endPoint.y - wall.startPoint.y;
        const steps = Math.max(1, Math.round(Math.max(Math.abs(dx), Math.abs(dy))));
        const thickness = Math.max(2, Math.round(wall.thickness + expand));
        const radius = Math.max(1, Math.round(thickness / 2));

        for (let step = 0; step <= steps; step += 1) {
            const t = step / steps;
            const x = Math.round(wall.startPoint.x + dx * t);
            const y = Math.round(wall.startPoint.y + dy * t);

            for (let offsetY = -radius; offsetY <= radius; offsetY += 1) {
                for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
                    const drawX = x + offsetX;
                    const drawY = y + offsetY;

                    if (drawX < 0 || drawX >= width || drawY < 0 || drawY >= height) {
                        continue;
                    }

                    mask[getIndex(drawX, drawY, width)] = 1;
                }
            }
        }
    }

    return mask;
};

export const createBoundingBox = (minX: number, minY: number, maxX: number, maxY: number): BoundingBox => ({
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
});

export const traceComponentBoundary = (
    mask: Uint8ClampedArray,
    width: number,
    height: number,
    component: Pick<ConnectedComponent, 'minX' | 'minY' | 'maxX' | 'maxY'>,
): Point[] => {
    const start = findBoundaryStart(mask, width, component);
    if (!start) {
        return [
            { x: component.minX, y: component.minY },
            { x: component.maxX, y: component.minY },
            { x: component.maxX, y: component.maxY },
            { x: component.minX, y: component.maxY },
        ];
    }

    const directions = [
        [1, 0],
        [1, 1],
        [0, 1],
        [-1, 1],
        [-1, 0],
        [-1, -1],
        [0, -1],
        [1, -1],
    ] as const;

    const boundary: Point[] = [];
    let current = start;
    let directionIndex = 0;
    const maxSteps = Math.max(64, (component.maxX - component.minX + component.maxY - component.minY) * 12);

    for (let step = 0; step < maxSteps; step += 1) {
        boundary.push({ x: current.x, y: current.y });
        let moved = false;

        for (let offset = 0; offset < directions.length; offset += 1) {
            const nextDirectionIndex = (directionIndex + offset + 6) % directions.length;
            const [dx, dy] = directions[nextDirectionIndex];
            const nextX = current.x + dx;
            const nextY = current.y + dy;

            if (
                nextX < component.minX
                || nextX > component.maxX
                || nextY < component.minY
                || nextY > component.maxY
                || nextX < 0
                || nextX >= width
                || nextY < 0
                || nextY >= height
            ) {
                continue;
            }

            if (!mask[getIndex(nextX, nextY, width)]) {
                continue;
            }

            current = { x: nextX, y: nextY };
            directionIndex = nextDirectionIndex;
            moved = true;
            break;
        }

        if (!moved) {
            break;
        }

        if (step > 8 && current.x === start.x && current.y === start.y) {
            break;
        }
    }

    return simplifyPolyline(boundary, Math.max(2, Math.round(boundary.length / 24)));
};

const findBoundaryStart = (
    mask: Uint8ClampedArray,
    width: number,
    component: Pick<ConnectedComponent, 'minX' | 'minY' | 'maxX' | 'maxY'>,
): Point | null => {
    for (let y = component.minY; y <= component.maxY; y += 1) {
        for (let x = component.minX; x <= component.maxX; x += 1) {
            if (!mask[getIndex(x, y, width)]) {
                continue;
            }

            const neighbors = [
                [x + 1, y],
                [x - 1, y],
                [x, y + 1],
                [x, y - 1],
            ];

            if (neighbors.some(([nextX, nextY]) => (
                nextX < 0
                || nextX >= width
                || nextY < component.minY
                || nextY > component.maxY
                || !mask[getIndex(nextX, nextY, width)]
            ))) {
                return { x, y };
            }
        }
    }

    return null;
};

export const simplifyPolyline = (points: Point[], step: number): Point[] => {
    if (points.length <= 8 || step <= 1) {
        return dedupeSequentialPoints(points);
    }

    const sampled: Point[] = [];
    for (let index = 0; index < points.length; index += step) {
        sampled.push(points[index]);
    }

    const lastPoint = points[points.length - 1];
    if (sampled.length === 0 || sampled[sampled.length - 1].x !== lastPoint.x || sampled[sampled.length - 1].y !== lastPoint.y) {
        sampled.push(lastPoint);
    }

    return dedupeSequentialPoints(sampled);
};

export const smoothOrthogonalBoundary = (points: Point[]): Point[] => {
    if (points.length < 4) {
        return points;
    }

    const smoothed = points.map((point, index) => {
        const previous = points[(index - 1 + points.length) % points.length];
        const next = points[(index + 1) % points.length];
        const alignX = Math.abs(previous.x - next.x) <= 2;
        const alignY = Math.abs(previous.y - next.y) <= 2;

        return {
            x: alignX ? Math.round((previous.x + next.x) / 2) : point.x,
            y: alignY ? Math.round((previous.y + next.y) / 2) : point.y,
        };
    });

    return dedupeSequentialPoints(smoothed);
};

const dedupeSequentialPoints = (points: Point[]): Point[] => {
    const deduped: Point[] = [];
    for (const point of points) {
        const previous = deduped[deduped.length - 1];
        if (!previous || previous.x !== point.x || previous.y !== point.y) {
            deduped.push(point);
        }
    }

    return deduped;
};
