"""Raster → vector pipeline: skeletonize wall masks + LSD for fine segments."""
from __future__ import annotations

from dataclasses import dataclass
from typing import List, Tuple

import cv2
import numpy as np
from skimage.morphology import skeletonize

from .imaging import preprocess_for_lines, to_grayscale


@dataclass
class LineSegment:
    x1: float
    y1: float
    x2: float
    y2: float
    thickness: float
    confidence: float

    def length(self) -> float:
        return float(np.hypot(self.x2 - self.x1, self.y2 - self.y1))

    def orientation(self) -> str:
        dx = abs(self.x2 - self.x1)
        dy = abs(self.y2 - self.y1)
        if dy < dx * 0.2:
            return "horizontal"
        if dx < dy * 0.2:
            return "vertical"
        return "diagonal"


def _estimate_local_thickness(binary: np.ndarray, x: float, y: float) -> float:
    """Return the distance transform value at (x,y) as a thickness estimate."""
    dist = cv2.distanceTransform(binary, cv2.DIST_L2, 3)
    xi = int(np.clip(round(x), 0, dist.shape[1] - 1))
    yi = int(np.clip(round(y), 0, dist.shape[0] - 1))
    return float(max(1.0, dist[yi, xi] * 2.0))


def _merge_collinear(segments: List[LineSegment], tolerance: float = 4.0) -> List[LineSegment]:
    """Greedy merge of near-collinear, overlapping segments."""
    merged: List[LineSegment] = []
    for segment in sorted(segments, key=lambda s: -s.length()):
        target = None
        for existing in merged:
            if existing.orientation() != segment.orientation():
                continue
            if existing.orientation() == "horizontal":
                if abs((existing.y1 + existing.y2) / 2 - (segment.y1 + segment.y2) / 2) > tolerance:
                    continue
                ax1, ax2 = sorted([existing.x1, existing.x2])
                bx1, bx2 = sorted([segment.x1, segment.x2])
                if max(ax1, bx1) - min(ax2, bx2) > tolerance * 3:
                    continue
            elif existing.orientation() == "vertical":
                if abs((existing.x1 + existing.x2) / 2 - (segment.x1 + segment.x2) / 2) > tolerance:
                    continue
                ay1, ay2 = sorted([existing.y1, existing.y2])
                by1, by2 = sorted([segment.y1, segment.y2])
                if max(ay1, by1) - min(ay2, by2) > tolerance * 3:
                    continue
            else:
                continue
            target = existing
            break

        if target is None:
            merged.append(segment)
            continue

        # Fuse by taking the extremal endpoints along the dominant axis.
        if target.orientation() == "horizontal":
            xs = [target.x1, target.x2, segment.x1, segment.x2]
            ys = [target.y1, target.y2, segment.y1, segment.y2]
            target.x1 = min(xs)
            target.x2 = max(xs)
            target.y1 = target.y2 = float(np.mean(ys))
        elif target.orientation() == "vertical":
            xs = [target.x1, target.x2, segment.x1, segment.x2]
            ys = [target.y1, target.y2, segment.y1, segment.y2]
            target.x1 = target.x2 = float(np.mean(xs))
            target.y1 = min(ys)
            target.y2 = max(ys)

        target.thickness = max(target.thickness, segment.thickness)
        target.confidence = max(target.confidence, segment.confidence)

    return merged


def extract_lsd_segments(gray: np.ndarray, min_length: float) -> List[Tuple[float, float, float, float, float]]:
    """Use the Fast Line Detector when available, falling back to HoughLinesP.
    Returns (x1, y1, x2, y2, score) tuples."""
    lines: List[Tuple[float, float, float, float, float]] = []
    try:
        if hasattr(cv2, "ximgproc"):
            detector = cv2.ximgproc.createFastLineDetector(
                length_threshold=int(min_length),
                distance_threshold=1.414,
                canny_th1=50.0,
                canny_th2=50.0,
                canny_aperture_size=3,
                do_merge=True,
            )
            detected = detector.detect(gray)
            if detected is not None:
                for entry in detected:
                    x1, y1, x2, y2 = entry[0]
                    length = float(np.hypot(x2 - x1, y2 - y1))
                    if length >= min_length:
                        lines.append((float(x1), float(y1), float(x2), float(y2), length))
                return lines
    except cv2.error:
        pass

    edges = cv2.Canny(gray, 60, 180)
    hough = cv2.HoughLinesP(
        edges,
        1,
        np.pi / 360,
        threshold=max(40, int(min_length * 0.4)),
        minLineLength=int(min_length),
        maxLineGap=int(min_length * 0.25),
    )
    if hough is None:
        return lines
    for entry in hough:
        x1, y1, x2, y2 = entry[0]
        length = float(np.hypot(x2 - x1, y2 - y1))
        lines.append((float(x1), float(y1), float(x2), float(y2), length))
    return lines


def skeleton_segments(
    binary: np.ndarray,
    min_length: float,
) -> List[LineSegment]:
    """Skeletonize the binary mask, then walk contours of the skeleton
    to produce centerline segments (thickness = distance transform)."""
    mask = (binary > 0).astype(np.uint8)
    skel = skeletonize(mask.astype(bool)).astype(np.uint8) * 255
    contours, _ = cv2.findContours(skel, cv2.RETR_LIST, cv2.CHAIN_APPROX_NONE)
    dist_binary = (binary > 0).astype(np.uint8)
    distance = cv2.distanceTransform(dist_binary, cv2.DIST_L2, 3)

    segments: List[LineSegment] = []
    for contour in contours:
        if len(contour) < max(6, int(min_length)):
            continue
        points = contour.reshape(-1, 2)
        approx = cv2.approxPolyDP(points, epsilon=2.0, closed=False).reshape(-1, 2)
        for index in range(len(approx) - 1):
            p1 = approx[index]
            p2 = approx[index + 1]
            length = float(np.hypot(p2[0] - p1[0], p2[1] - p1[1]))
            if length < min_length:
                continue
            mid_x = (p1[0] + p2[0]) / 2.0
            mid_y = (p1[1] + p2[1]) / 2.0
            xi = int(np.clip(round(mid_x), 0, distance.shape[1] - 1))
            yi = int(np.clip(round(mid_y), 0, distance.shape[0] - 1))
            thickness = float(max(2.0, distance[yi, xi] * 2.0))
            segments.append(
                LineSegment(
                    x1=float(p1[0]),
                    y1=float(p1[1]),
                    x2=float(p2[0]),
                    y2=float(p2[1]),
                    thickness=thickness,
                    confidence=min(0.9, 0.5 + length / max(float(distance.shape[0]), 1.0)),
                )
            )

    return segments


def vectorize(
    image: np.ndarray,
    downsample: int | None = None,
) -> Tuple[List[LineSegment], int, int]:
    """Run the full raster→vector pipeline. Returns (segments, width, height)
    in the coordinate space of the returned dimensions (post-downsample)."""
    if downsample and max(image.shape[:2]) > downsample:
        scale = downsample / float(max(image.shape[:2]))
        new_w = max(16, int(image.shape[1] * scale))
        new_h = max(16, int(image.shape[0] * scale))
        image = cv2.resize(image, (new_w, new_h), interpolation=cv2.INTER_AREA)

    gray = to_grayscale(image)
    binary = preprocess_for_lines(image)
    min_length = max(16.0, min(image.shape[:2]) * 0.04)

    skeleton = skeleton_segments(binary, min_length)
    lsd_raw = extract_lsd_segments(gray, min_length)
    lsd_segments = [
        LineSegment(
            x1=x1,
            y1=y1,
            x2=x2,
            y2=y2,
            thickness=_estimate_local_thickness(binary, (x1 + x2) / 2, (y1 + y2) / 2),
            confidence=min(0.85, 0.4 + score / max(float(min(image.shape[:2])), 1.0)),
        )
        for x1, y1, x2, y2, score in lsd_raw
    ]

    merged = _merge_collinear(skeleton + lsd_segments)
    merged = [segment for segment in merged if segment.length() >= min_length]
    return merged, image.shape[1], image.shape[0]
