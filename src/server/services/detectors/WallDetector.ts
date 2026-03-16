import { AnalysisImageData } from '../ImageProcessor';
import { BoundingBox, MLSegmentationRegion, Point, Wall } from '../../../shared/types';
import { createBoundingBox, distance, findConnectedComponents, maskBoundingBoxes } from './DetectionUtils';
import { v4 as uuidv4 } from 'uuid';

interface AxisRun {
    line: number;
    start: number;
    end: number;
    density: number;
}

interface AxisGroup {
    minLine: number;
    maxLine: number;
    start: number;
    end: number;
    densities: number[];
}

export class WallDetector {
    async detect(
        analysis: AnalysisImageData,
        excludedRegions: BoundingBox[] = [],
        segmentationRegions: MLSegmentationRegion[] = [],
    ): Promise<Wall[]> {
        const minLength = Math.max(16, Math.round(Math.min(analysis.width, analysis.height) * 0.08));
        const maskedBinary = excludedRegions.length
            ? maskBoundingBoxes(analysis.binary, analysis.width, analysis.height, excludedRegions, 4)
            : analysis.binary;

        const horizontalRuns = this.collectRuns(maskedBinary, analysis.edges, analysis.width, analysis.height, 'horizontal', minLength);
        const verticalRuns = this.collectRuns(maskedBinary, analysis.edges, analysis.width, analysis.height, 'vertical', minLength);

        const horizontalWalls = this.groupRuns(horizontalRuns, 'horizontal', analysis.width, analysis.height, minLength);
        const verticalWalls = this.groupRuns(verticalRuns, 'vertical', analysis.width, analysis.height, minLength);
        const componentWalls = this.extractWallsFromComponents(maskedBinary, analysis.width, analysis.height, minLength);

        // Hough transform for diagonal lines
        const maskedEdges = excludedRegions.length
            ? maskBoundingBoxes(analysis.edges, analysis.width, analysis.height, excludedRegions, 4)
            : analysis.edges;
        const diagonalWalls = this.detectDiagonalWalls(maskedEdges, analysis.width, analysis.height, minLength);

        // Detect colored lines if color masks are available
        const colorWalls = analysis.colorMasks
            ? this.detectColorWalls(analysis.colorMasks, analysis.width, analysis.height, minLength)
            : [];
        const segmentationWalls = segmentationRegions.length
            ? this.extractWallsFromSegmentationRegions(segmentationRegions, analysis.width, analysis.height, minLength)
            : [];

        const mergedWalls = this.mergeSimilarWalls([
            ...horizontalWalls,
            ...verticalWalls,
            ...componentWalls,
            ...diagonalWalls,
            ...colorWalls,
            ...segmentationWalls,
        ]);
        const snappedWalls = this.snapIntersections(mergedWalls);
        const splitWalls = this.splitWallsAtIntersections(snappedWalls);
        const deduped = this.deduplicateOverlapping(this.mergeSimilarWalls(splitWalls));
        const walls = this.normalizeWalls(deduped);

        return walls.length ? walls : this.createFallbackWalls(analysis.width, analysis.height);
    }

    private extractWallsFromSegmentationRegions(
        regions: MLSegmentationRegion[],
        width: number,
        height: number,
        minLength: number,
    ): Wall[] {
        const wallRegions = regions.filter((region) => /wall/.test(region.label));
        if (!wallRegions.length) {
            return [];
        }

        const mask = new Uint8ClampedArray(width * height);
        for (const region of wallRegions) {
            const startX = Math.max(0, Math.floor(region.boundingBox.x));
            const startY = Math.max(0, Math.floor(region.boundingBox.y));
            const endX = Math.min(width, Math.ceil(region.boundingBox.x + region.boundingBox.width));
            const endY = Math.min(height, Math.ceil(region.boundingBox.y + region.boundingBox.height));

            for (let y = startY; y < endY; y += 1) {
                for (let x = startX; x < endX; x += 1) {
                    mask[y * width + x] = 1;
                }
            }
        }

        const walls = this.extractWallsFromComponents(mask, width, height, Math.max(10, Math.round(minLength * 0.65)));

        return walls.map((wall) => ({
            ...wall,
            confidence: Math.min(0.95, wall.confidence + 0.1),
            thickness: Math.max(wall.thickness, 6),
        }));
    }

    /**
     * Hough Line Transform — detects line segments at any angle from edge pixels.
     * Returns Wall objects for lines that are NOT near-horizontal or near-vertical
     * (those are already covered by the run-based detector).
     */
    private detectDiagonalWalls(
        edges: Uint8ClampedArray,
        width: number,
        height: number,
        minLength: number,
    ): Wall[] {
        const diag = Math.sqrt(width * width + height * height);
        const rhoStep = 1;
        const thetaSteps = 180;
        const thetaStep = Math.PI / thetaSteps;
        const rhoMax = Math.ceil(diag);
        const rhoOffset = rhoMax; // shift so index ≥ 0
        const accumWidth = 2 * rhoMax + 1;

        // Build accumulator
        const accumulator = new Uint32Array(accumWidth * thetaSteps);
        const cosTable = new Float64Array(thetaSteps);
        const sinTable = new Float64Array(thetaSteps);
        for (let t = 0; t < thetaSteps; t += 1) {
            const theta = t * thetaStep;
            cosTable[t] = Math.cos(theta);
            sinTable[t] = Math.sin(theta);
        }

        // Vote
        for (let y = 0; y < height; y += 1) {
            for (let x = 0; x < width; x += 1) {
                if (!edges[y * width + x]) continue;
                for (let t = 0; t < thetaSteps; t += 1) {
                    const rho = Math.round(x * cosTable[t] + y * sinTable[t]) + rhoOffset;
                    accumulator[rho * thetaSteps + t] += 1;
                }
            }
        }

        // Find peaks — threshold based on image dimension
        const voteThreshold = Math.max(30, Math.round(Math.min(width, height) * 0.04));
        const peaks: Array<{ rho: number; theta: number; votes: number }> = [];

        for (let r = 0; r < accumWidth; r += 1) {
            for (let t = 0; t < thetaSteps; t += 1) {
                const votes = accumulator[r * thetaSteps + t];
                if (votes < voteThreshold) continue;

                // Local maximum check (3×3)
                let isMax = true;
                for (let dr = -1; dr <= 1 && isMax; dr += 1) {
                    for (let dt = -1; dt <= 1; dt += 1) {
                        if (dr === 0 && dt === 0) continue;
                        const nr = r + dr;
                        const nt = t + dt;
                        if (nr < 0 || nr >= accumWidth || nt < 0 || nt >= thetaSteps) continue;
                        if (accumulator[nr * thetaSteps + nt] > votes) { isMax = false; break; }
                    }
                }

                if (isMax) {
                    const theta = t * thetaStep;
                    const angleDeg = (theta * 180) / Math.PI;
                    // Skip near-horizontal (0°, 180°) and near-vertical (90°) — already handled
                    if (angleDeg < 15 || angleDeg > 165 || (angleDeg > 75 && angleDeg < 105)) continue;
                    peaks.push({ rho: r - rhoOffset, theta, votes });
                }
            }
        }

        // Sort by votes and take top peaks
        peaks.sort((a, b) => b.votes - a.votes);
        const maxPeaks = Math.min(peaks.length, 50);

        // Convert each peak to a wall segment by finding the extent of edge support
        const walls: Wall[] = [];
        for (let i = 0; i < maxPeaks; i += 1) {
            const { rho, theta } = peaks[i];
            const cosT = Math.cos(theta);
            const sinT = Math.sin(theta);

            // Find edge pixels near this line
            const linePixels: Array<{ x: number; y: number }> = [];
            const tolerance = 2;

            for (let y = 0; y < height; y += 1) {
                for (let x = 0; x < width; x += 1) {
                    if (!edges[y * width + x]) continue;
                    const d = Math.abs(x * cosT + y * sinT - rho);
                    if (d <= tolerance) {
                        linePixels.push({ x, y });
                    }
                }
            }

            if (linePixels.length < minLength) continue;

            // Project onto line direction to find extents
            const dirX = -sinT;
            const dirY = cosT;
            let minProj = Infinity, maxProj = -Infinity;
            let minPt = linePixels[0], maxPt = linePixels[0];

            for (const p of linePixels) {
                const proj = p.x * dirX + p.y * dirY;
                if (proj < minProj) { minProj = proj; minPt = p; }
                if (proj > maxProj) { maxProj = proj; maxPt = p; }
            }

            const length = Math.hypot(maxPt.x - minPt.x, maxPt.y - minPt.y);
            if (length < minLength) continue;

            walls.push({
                id: uuidv4(),
                startPoint: { x: minPt.x, y: minPt.y },
                endPoint: { x: maxPt.x, y: maxPt.y },
                thickness: 4,
                height: 3,
                confidence: Math.min(0.85, 0.4 + linePixels.length / (length * 3)),
                orientation: 'diagonal',
            });
        }

        return walls;
    }

    /**
     * Detect walls from color channel binary masks (red, blue, green lines).
     */
    private detectColorWalls(
        colorMasks: NonNullable<AnalysisImageData['colorMasks']>,
        width: number,
        height: number,
        minLength: number,
    ): Wall[] {
        const walls: Wall[] = [];

        for (const [_name, mask] of Object.entries(colorMasks)) {
            // Apply morphology to clean up sparse color pixels
            const closed = this.morphClose(mask, width, height);
            const components = findConnectedComponents(closed, width, height, Math.max(20, minLength * 2));

            for (const comp of components) {
                if (comp.touchesBorder) continue;
                const box = createBoundingBox(comp.minX, comp.minY, comp.maxX, comp.maxY);
                const aspect = Math.max(box.width, box.height) / Math.max(1, Math.min(box.width, box.height));
                if (aspect < 3) continue; // Not elongated enough to be a wall

                const isH = box.width > box.height;
                const startPoint: Point = isH
                    ? { x: box.x, y: box.y + box.height / 2 }
                    : { x: box.x + box.width / 2, y: box.y };
                const endPoint: Point = isH
                    ? { x: box.x + box.width, y: box.y + box.height / 2 }
                    : { x: box.x + box.width / 2, y: box.y + box.height };

                if (distance(startPoint, endPoint) < minLength) continue;

                walls.push({
                    id: uuidv4(),
                    startPoint,
                    endPoint,
                    thickness: isH ? box.height : box.width,
                    height: 3,
                    confidence: Math.min(0.8, 0.35 + comp.fillRatio * 0.3),
                    orientation: isH ? 'horizontal' : 'vertical',
                });
            }
        }

        return walls;
    }

    private morphClose(mask: Uint8ClampedArray, width: number, height: number): Uint8ClampedArray {
        // Dilate then erode with a 3×3 kernel
        const dilated = new Uint8ClampedArray(mask.length);
        for (let y = 0; y < height; y += 1) {
            for (let x = 0; x < width; x += 1) {
                let val = 0;
                for (let dy = -1; dy <= 1 && !val; dy += 1) {
                    for (let dx = -1; dx <= 1; dx += 1) {
                        const nx = x + dx, ny = y + dy;
                        if (nx >= 0 && nx < width && ny >= 0 && ny < height && mask[ny * width + nx]) { val = 1; break; }
                    }
                }
                dilated[y * width + x] = val;
            }
        }
        const eroded = new Uint8ClampedArray(mask.length);
        for (let y = 0; y < height; y += 1) {
            for (let x = 0; x < width; x += 1) {
                let val = 1;
                for (let dy = -1; dy <= 1 && val; dy += 1) {
                    for (let dx = -1; dx <= 1; dx += 1) {
                        const nx = x + dx, ny = y + dy;
                        if (nx < 0 || nx >= width || ny < 0 || ny >= height || !dilated[ny * width + nx]) { val = 0; break; }
                    }
                }
                eroded[y * width + x] = val;
            }
        }
        return eroded;
    }

    /**
     * Remove overlapping collinear segments — project onto shared axis,
     * union intervals, re-emit as single walls.
     */
    private deduplicateOverlapping(walls: Wall[]): Wall[] {
        const result: Wall[] = [];
        const used = new Set<number>();

        for (let i = 0; i < walls.length; i += 1) {
            if (used.has(i)) continue;

            const wall = walls[i];
            if (wall.orientation === 'diagonal') {
                result.push(wall);
                continue;
            }

            // Collect all collinear walls on the same axis
            const group = [wall];
            const primaryCoord = this.primaryCoordinate(wall);

            for (let j = i + 1; j < walls.length; j += 1) {
                if (used.has(j)) continue;
                const other = walls[j];
                if (other.orientation !== wall.orientation) continue;

                const otherPrimary = this.primaryCoordinate(other);
                const maxThick = Math.max(wall.thickness, other.thickness);
                if (Math.abs(primaryCoord - otherPrimary) > maxThick) continue;

                // Check interval overlap
                const overlapStart = Math.max(this.secondaryStart(wall), this.secondaryStart(other));
                const overlapEnd = Math.min(this.secondaryEnd(wall), this.secondaryEnd(other));
                if (overlapEnd - overlapStart >= -maxThick) {
                    group.push(other);
                    used.add(j);
                }
            }

            if (group.length === 1) {
                result.push(wall);
                continue;
            }

            // Union intervals
            const intervals = group
                .map(w => ({ start: this.secondaryStart(w), end: this.secondaryEnd(w), confidence: w.confidence, thickness: w.thickness }))
                .sort((a, b) => a.start - b.start);

            const merged: typeof intervals = [intervals[0]];
            for (let k = 1; k < intervals.length; k += 1) {
                const last = merged[merged.length - 1];
                if (intervals[k].start <= last.end + last.thickness) {
                    last.end = Math.max(last.end, intervals[k].end);
                    last.confidence = Math.max(last.confidence, intervals[k].confidence);
                    last.thickness = Math.max(last.thickness, intervals[k].thickness);
                } else {
                    merged.push({ ...intervals[k] });
                }
            }

            const avgPrimary = group.reduce((s, w) => s + this.primaryCoordinate(w), 0) / group.length;
            const maxThickness = Math.max(...group.map(w => w.thickness));

            for (const seg of merged) {
                const startPoint: Point = wall.orientation === 'horizontal'
                    ? { x: seg.start, y: avgPrimary }
                    : { x: avgPrimary, y: seg.start };
                const endPoint: Point = wall.orientation === 'horizontal'
                    ? { x: seg.end, y: avgPrimary }
                    : { x: avgPrimary, y: seg.end };

                result.push({
                    id: uuidv4(),
                    startPoint,
                    endPoint,
                    thickness: maxThickness,
                    height: 3,
                    confidence: seg.confidence,
                    orientation: wall.orientation,
                });
            }
        }

        return result;
    }

    private extractWallsFromComponents(
        binary: Uint8ClampedArray,
        width: number,
        height: number,
        minLength: number,
    ): Wall[] {
        const minArea = Math.max(30, Math.round(width * height * 0.00015));
        const components = findConnectedComponents(binary, width, height, minArea);

        return components
            .filter((component) => !component.touchesBorder)
            .map((component) => {
                const box = createBoundingBox(component.minX, component.minY, component.maxX, component.maxY);
                const isHorizontal = box.width >= box.height * 1.8;
                const isVertical = box.height >= box.width * 1.8;

                if (!isHorizontal && !isVertical) {
                    return null;
                }

                const orientation = isHorizontal ? 'horizontal' : 'vertical';
                const startPoint: Point = isHorizontal
                    ? { x: box.x, y: box.y + box.height / 2 }
                    : { x: box.x + box.width / 2, y: box.y };
                const endPoint: Point = isHorizontal
                    ? { x: box.x + box.width, y: box.y + box.height / 2 }
                    : { x: box.x + box.width / 2, y: box.y + box.height };

                if (distance(startPoint, endPoint) < minLength) {
                    return null;
                }

                return {
                    id: uuidv4(),
                    startPoint,
                    endPoint,
                    thickness: isHorizontal ? box.height : box.width,
                    height: 3,
                    confidence: Math.min(0.92, 0.45 + component.fillRatio * 0.28),
                    orientation,
                } as Wall;
            })
            .filter((wall): wall is Wall => Boolean(wall));
    }

    private collectRuns(
        binary: Uint8ClampedArray,
        edges: Uint8ClampedArray,
        width: number,
        height: number,
        orientation: 'horizontal' | 'vertical',
        minLength: number,
    ): AxisRun[] {
        const runs: AxisRun[] = [];
        const mainSize = orientation === 'horizontal' ? height : width;
        const crossSize = orientation === 'horizontal' ? width : height;
        const gapAllowance = Math.max(1, Math.round(crossSize * 0.0035));

        for (let line = 0; line < mainSize; line += 1) {
            let start = -1;
            let darkPixels = 0;
            let edgePixels = 0;
            let gapPixels = 0;
            let totalPixels = 0;

            for (let cross = 0; cross < crossSize; cross += 1) {
                const x = orientation === 'horizontal' ? cross : line;
                const y = orientation === 'horizontal' ? line : cross;
                const isDark = binary[y * width + x] > 0;

                if (isDark) {
                    if (start === -1) {
                        start = cross;
                    }
                    darkPixels += 1;
                    edgePixels += edges[y * width + x] > 0 ? 1 : 0;
                    totalPixels += 1;
                    gapPixels = 0;
                    continue;
                }

                if (start === -1) {
                    continue;
                }

                gapPixels += 1;
                totalPixels += 1;
                if (gapPixels <= gapAllowance) {
                    continue;
                }

                const end = cross - gapPixels;
                const length = end - start + 1;
                const density = darkPixels / Math.max(1, totalPixels - gapPixels);
                const edgeSupport = edgePixels / Math.max(1, darkPixels);
                if (length >= minLength && density >= 0.58 && edgeSupport >= 0.05) {
                    runs.push({ line, start, end, density: (density * 0.75) + (edgeSupport * 0.25) });
                }

                start = -1;
                darkPixels = 0;
                edgePixels = 0;
                gapPixels = 0;
                totalPixels = 0;
            }

            if (start !== -1) {
                const end = crossSize - 1;
                const length = end - start + 1;
                const density = darkPixels / Math.max(1, totalPixels);
                const edgeSupport = edgePixels / Math.max(1, darkPixels);
                if (length >= minLength && density >= 0.58 && edgeSupport >= 0.05) {
                    runs.push({ line, start, end, density: (density * 0.75) + (edgeSupport * 0.25) });
                }
            }
        }

        return runs;
    }

    private groupRuns(
        runs: AxisRun[],
        orientation: 'horizontal' | 'vertical',
        width: number,
        height: number,
        minLength: number,
    ): Wall[] {
        const groups: AxisGroup[] = [];
        const lineTolerance = Math.max(2, Math.round(Math.min(width, height) * 0.005));
        const overlapTolerance = Math.max(6, Math.round(Math.min(width, height) * 0.01));

        const sortedRuns = [...runs].sort((a, b) => (
            a.line - b.line || a.start - b.start || a.end - b.end
        ));

        for (const run of sortedRuns) {
            const matchingGroup = groups.find((group) => (
                run.line - group.maxLine <= lineTolerance
                && this.intervalsOverlap(group.start, group.end, run.start, run.end, overlapTolerance)
            ));

            if (matchingGroup) {
                matchingGroup.maxLine = Math.max(matchingGroup.maxLine, run.line);
                matchingGroup.start = Math.min(matchingGroup.start, run.start);
                matchingGroup.end = Math.max(matchingGroup.end, run.end);
                matchingGroup.densities.push(run.density);
            } else {
                groups.push({
                    minLine: run.line,
                    maxLine: run.line,
                    start: run.start,
                    end: run.end,
                    densities: [run.density],
                });
            }
        }

        return groups
            .map((group) => this.groupToWall(group, orientation))
            .filter((wall): wall is Wall => Boolean(wall))
            .filter((wall) => distance(wall.startPoint, wall.endPoint) >= minLength);
    }

    private groupToWall(group: AxisGroup, orientation: 'horizontal' | 'vertical'): Wall | null {
        const thickness = group.maxLine - group.minLine + 1;
        const density = group.densities.reduce((sum, value) => sum + value, 0) / Math.max(1, group.densities.length);
        const centerLine = (group.minLine + group.maxLine) / 2;

        const startPoint: Point = orientation === 'horizontal'
            ? { x: group.start, y: centerLine }
            : { x: centerLine, y: group.start };
        const endPoint: Point = orientation === 'horizontal'
            ? { x: group.end, y: centerLine }
            : { x: centerLine, y: group.end };

        const length = distance(startPoint, endPoint);
        if (length <= 0) {
            return null;
        }

        const confidence = Math.min(0.96, 0.42 + density * 0.35 + Math.min(thickness / 12, 0.12));
        return {
            id: uuidv4(),
            startPoint,
            endPoint,
            thickness,
            height: 3,
            confidence,
            orientation,
        };
    }

    private mergeSimilarWalls(walls: Wall[]): Wall[] {
        const merged: Wall[] = [];
        const gapTolerance = 18;

        for (const wall of walls
            .filter((candidate) => distance(candidate.startPoint, candidate.endPoint) >= Math.max(12, candidate.thickness * 2))
            .sort((a, b) => a.startPoint.x - b.startPoint.x || a.startPoint.y - b.startPoint.y)) {
            const candidate = merged.find((existing) => (
                existing.orientation === wall.orientation
                && Math.abs(this.primaryCoordinate(existing) - this.primaryCoordinate(wall)) <= Math.max(existing.thickness, wall.thickness)
                && this.intervalsOverlap(
                    this.secondaryStart(existing),
                    this.secondaryEnd(existing),
                    this.secondaryStart(wall),
                    this.secondaryEnd(wall),
                    Math.max(existing.thickness, wall.thickness) * 2 + gapTolerance,
                )
            ));

            if (!candidate) {
                merged.push(wall);
                continue;
            }

            candidate.startPoint = this.mergePoint(candidate, wall, 'start');
            candidate.endPoint = this.mergePoint(candidate, wall, 'end');
            candidate.thickness = Math.max(candidate.thickness, wall.thickness);
            candidate.confidence = Math.min(0.98, Math.max(candidate.confidence, wall.confidence) + 0.02);
        }

        return this.pruneEmbeddedWalls(merged);
    }

    private pruneEmbeddedWalls(walls: Wall[]): Wall[] {
        return walls.filter((wall, index) => !walls.some((candidate, candidateIndex) => {
            if (index === candidateIndex || candidate.orientation !== wall.orientation) {
                return false;
            }

            const primaryDelta = Math.abs(this.primaryCoordinate(candidate) - this.primaryCoordinate(wall));
            const withinPrimary = primaryDelta <= Math.max(candidate.thickness, wall.thickness) * 1.2;
            const withinSecondary = this.secondaryStart(wall) >= this.secondaryStart(candidate) - wall.thickness
                && this.secondaryEnd(wall) <= this.secondaryEnd(candidate) + wall.thickness;

            return withinPrimary && withinSecondary && candidate.confidence >= wall.confidence;
        }));
    }

    private splitWallsAtIntersections(walls: Wall[]): Wall[] {
        const splitTolerance = 6;
        const horizontalWalls = walls.filter((wall) => wall.orientation === 'horizontal');
        const verticalWalls = walls.filter((wall) => wall.orientation === 'vertical');
        const horizontalBreaks = new Map<string, number[]>();
        const verticalBreaks = new Map<string, number[]>();

        for (const horizontalWall of horizontalWalls) {
            const intersections: number[] = [];
            const minX = Math.min(horizontalWall.startPoint.x, horizontalWall.endPoint.x);
            const maxX = Math.max(horizontalWall.startPoint.x, horizontalWall.endPoint.x);
            const y = (horizontalWall.startPoint.y + horizontalWall.endPoint.y) / 2;

            for (const verticalWall of verticalWalls) {
                const x = (verticalWall.startPoint.x + verticalWall.endPoint.x) / 2;
                const minY = Math.min(verticalWall.startPoint.y, verticalWall.endPoint.y);
                const maxY = Math.max(verticalWall.startPoint.y, verticalWall.endPoint.y);

                if (x > minX + splitTolerance && x < maxX - splitTolerance && y >= minY - splitTolerance && y <= maxY + splitTolerance) {
                    intersections.push(x);
                    const breaks = verticalBreaks.get(verticalWall.id) || [];
                    breaks.push(y);
                    verticalBreaks.set(verticalWall.id, breaks);
                }
            }

            if (intersections.length) {
                horizontalBreaks.set(horizontalWall.id, intersections);
            }
        }

        const splitWalls: Wall[] = [];
        for (const wall of walls) {
            const breakpoints = wall.orientation === 'horizontal'
                ? horizontalBreaks.get(wall.id)
                : verticalBreaks.get(wall.id);

            if (!breakpoints?.length) {
                splitWalls.push(wall);
                continue;
            }

            const sortedBreaks = [...new Set(breakpoints.map((value) => Math.round(value)))].sort((a, b) => a - b);
            const segments = wall.orientation === 'horizontal'
                ? [Math.min(wall.startPoint.x, wall.endPoint.x), ...sortedBreaks, Math.max(wall.startPoint.x, wall.endPoint.x)]
                : [Math.min(wall.startPoint.y, wall.endPoint.y), ...sortedBreaks, Math.max(wall.startPoint.y, wall.endPoint.y)];

            for (let index = 0; index < segments.length - 1; index += 1) {
                const start = segments[index];
                const end = segments[index + 1];
                if (end - start < Math.max(12, wall.thickness * 2)) {
                    continue;
                }

                splitWalls.push(this.createWallSegment(wall, start, end));
            }
        }

        return splitWalls;
    }

    private createWallSegment(wall: Wall, start: number, end: number): Wall {
        return wall.orientation === 'horizontal'
            ? {
                ...wall,
                id: uuidv4(),
                startPoint: { x: start, y: wall.startPoint.y },
                endPoint: { x: end, y: wall.endPoint.y },
            }
            : {
                ...wall,
                id: uuidv4(),
                startPoint: { x: wall.startPoint.x, y: start },
                endPoint: { x: wall.endPoint.x, y: end },
            };
    }

    private normalizeWalls(walls: Wall[]): Wall[] {
        return walls.map((wall) => ({
            ...wall,
            startPoint: {
                x: Math.round(wall.startPoint.x),
                y: Math.round(wall.startPoint.y),
            },
            endPoint: {
                x: Math.round(wall.endPoint.x),
                y: Math.round(wall.endPoint.y),
            },
            thickness: Math.max(2, Math.round(wall.thickness)),
        }));
    }

    private snapIntersections(walls: Wall[]): Wall[] {
        const snapTolerance = Math.max(4, Math.round(Math.min(...walls.map((wall) => wall.thickness)) || 4));
        const horizontalWalls = walls.filter((wall) => wall.orientation === 'horizontal');
        const verticalWalls = walls.filter((wall) => wall.orientation === 'vertical');

        for (const horizontalWall of horizontalWalls) {
            for (const verticalWall of verticalWalls) {
                const intersectionX = verticalWall.startPoint.x;
                const intersectionY = horizontalWall.startPoint.y;
                const horizontalMinX = Math.min(horizontalWall.startPoint.x, horizontalWall.endPoint.x) - snapTolerance;
                const horizontalMaxX = Math.max(horizontalWall.startPoint.x, horizontalWall.endPoint.x) + snapTolerance;
                const verticalMinY = Math.min(verticalWall.startPoint.y, verticalWall.endPoint.y) - snapTolerance;
                const verticalMaxY = Math.max(verticalWall.startPoint.y, verticalWall.endPoint.y) + snapTolerance;

                if (
                    intersectionX >= horizontalMinX
                    && intersectionX <= horizontalMaxX
                    && intersectionY >= verticalMinY
                    && intersectionY <= verticalMaxY
                ) {
                    if (Math.abs(horizontalWall.startPoint.x - intersectionX) <= snapTolerance) {
                        horizontalWall.startPoint.x = intersectionX;
                    }
                    if (Math.abs(horizontalWall.endPoint.x - intersectionX) <= snapTolerance) {
                        horizontalWall.endPoint.x = intersectionX;
                    }
                    if (Math.abs(verticalWall.startPoint.y - intersectionY) <= snapTolerance) {
                        verticalWall.startPoint.y = intersectionY;
                    }
                    if (Math.abs(verticalWall.endPoint.y - intersectionY) <= snapTolerance) {
                        verticalWall.endPoint.y = intersectionY;
                    }
                }
            }
        }

        return walls;
    }

    private mergePoint(base: Wall, other: Wall, endpoint: 'start' | 'end'): Point {
        const basePoint = endpoint === 'start' ? base.startPoint : base.endPoint;
        const otherPoint = endpoint === 'start' ? other.startPoint : other.endPoint;
        if (base.orientation === 'horizontal') {
            return {
                x: endpoint === 'start' ? Math.min(basePoint.x, otherPoint.x) : Math.max(basePoint.x, otherPoint.x),
                y: (basePoint.y + otherPoint.y) / 2,
            };
        }

        return {
            x: (basePoint.x + otherPoint.x) / 2,
            y: endpoint === 'start' ? Math.min(basePoint.y, otherPoint.y) : Math.max(basePoint.y, otherPoint.y),
        };
    }

    private primaryCoordinate(wall: Wall): number {
        return wall.orientation === 'horizontal'
            ? (wall.startPoint.y + wall.endPoint.y) / 2
            : (wall.startPoint.x + wall.endPoint.x) / 2;
    }

    private secondaryStart(wall: Wall): number {
        return wall.orientation === 'horizontal'
            ? Math.min(wall.startPoint.x, wall.endPoint.x)
            : Math.min(wall.startPoint.y, wall.endPoint.y);
    }

    private secondaryEnd(wall: Wall): number {
        return wall.orientation === 'horizontal'
            ? Math.max(wall.startPoint.x, wall.endPoint.x)
            : Math.max(wall.startPoint.y, wall.endPoint.y);
    }

    private intervalsOverlap(startA: number, endA: number, startB: number, endB: number, tolerance: number): boolean {
        return Math.min(endA, endB) - Math.max(startA, startB) >= -tolerance;
    }

    private createFallbackWalls(width: number, height: number): Wall[] {
        const inset = Math.max(10, Math.round(Math.min(width, height) * 0.08));
        const addWall = (startPoint: Point, endPoint: Point): Wall => ({
            id: uuidv4(),
            startPoint,
            endPoint,
            thickness: 6,
            height: 3,
            confidence: 0.35,
            orientation: Math.abs(startPoint.x - endPoint.x) >= Math.abs(startPoint.y - endPoint.y)
                ? 'horizontal'
                : 'vertical',
        });

        return [
            addWall({ x: inset, y: inset }, { x: width - inset, y: inset }),
            addWall({ x: width - inset, y: inset }, { x: width - inset, y: height - inset }),
            addWall({ x: width - inset, y: height - inset }, { x: inset, y: height - inset }),
            addWall({ x: inset, y: height - inset }, { x: inset, y: inset }),
        ];
    }
}
