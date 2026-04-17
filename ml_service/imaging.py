"""Image decoding and rectification utilities built on OpenCV."""
from __future__ import annotations

import base64
import io
from typing import Optional, Tuple

import cv2
import numpy as np
from PIL import Image


def decode_image_bytes(image_base64: str) -> bytes:
    return base64.b64decode(image_base64)


def decode_image(image_base64: str) -> np.ndarray:
    """Decode a base64 image into an OpenCV BGR ndarray."""
    raw = decode_image_bytes(image_base64)
    pil = Image.open(io.BytesIO(raw)).convert("RGB")
    rgb = np.array(pil)
    return cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)


def encode_image(image: np.ndarray) -> str:
    """Encode an OpenCV BGR ndarray back to base64 PNG."""
    success, buffer = cv2.imencode(".png", image)
    if not success:
        raise RuntimeError("failed to encode image")
    return base64.b64encode(buffer.tobytes()).decode("ascii")


def to_grayscale(image: np.ndarray) -> np.ndarray:
    if image.ndim == 2:
        return image
    return cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)


def preprocess_for_lines(image: np.ndarray) -> np.ndarray:
    """CLAHE + adaptive threshold pipeline tuned for scanned drawings."""
    gray = to_grayscale(image)
    clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))
    enhanced = clahe.apply(gray)
    enhanced = cv2.medianBlur(enhanced, 3)
    binary = cv2.adaptiveThreshold(
        enhanced,
        255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY_INV,
        31,
        8,
    )
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    return cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel, iterations=1)


def estimate_dominant_angle(binary: np.ndarray) -> float:
    """Return the rotation (degrees) that should be removed to make
    most wall lines horizontal/vertical. Uses a Hough-peak histogram."""
    lines = cv2.HoughLines(binary, 1, np.pi / 360, threshold=200)
    if lines is None or len(lines) == 0:
        return 0.0

    angles = []
    for entry in lines[:400]:
        _, theta = entry[0]
        deg = (np.degrees(theta) - 90.0) % 180.0
        if deg > 90.0:
            deg -= 180.0
        # Fold to [-45, 45] — we only care about deviation from orthogonal.
        folded = ((deg + 45.0) % 90.0) - 45.0
        angles.append(folded)

    if not angles:
        return 0.0

    histogram, edges = np.histogram(angles, bins=90, range=(-45.0, 45.0))
    peak = int(np.argmax(histogram))
    if histogram[peak] < 8:
        return 0.0
    return float((edges[peak] + edges[peak + 1]) / 2.0)


def rotate_image(image: np.ndarray, angle_degrees: float) -> np.ndarray:
    if abs(angle_degrees) < 0.05:
        return image
    height, width = image.shape[:2]
    center = (width / 2.0, height / 2.0)
    matrix = cv2.getRotationMatrix2D(center, angle_degrees, 1.0)
    cos = abs(matrix[0, 0])
    sin = abs(matrix[0, 1])
    new_width = int(height * sin + width * cos)
    new_height = int(height * cos + width * sin)
    matrix[0, 2] += (new_width / 2.0) - center[0]
    matrix[1, 2] += (new_height / 2.0) - center[1]
    return cv2.warpAffine(
        image,
        matrix,
        (new_width, new_height),
        flags=cv2.INTER_CUBIC,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=(255, 255, 255),
    )


def _order_quad(points: np.ndarray) -> np.ndarray:
    """Order 4 points as top-left, top-right, bottom-right, bottom-left."""
    rect = np.zeros((4, 2), dtype=np.float32)
    total = points.sum(axis=1)
    diff = np.diff(points, axis=1).flatten()
    rect[0] = points[np.argmin(total)]
    rect[2] = points[np.argmax(total)]
    rect[1] = points[np.argmin(diff)]
    rect[3] = points[np.argmax(diff)]
    return rect


def detect_page_quad(image: np.ndarray) -> Optional[np.ndarray]:
    """Find the largest quadrilateral contour that plausibly bounds the page."""
    gray = to_grayscale(image)
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(blurred, 40, 120)
    edges = cv2.dilate(edges, None, iterations=1)
    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None

    height, width = image.shape[:2]
    image_area = float(width * height)
    best: Optional[np.ndarray] = None
    best_area = 0.0

    for contour in contours:
        area = cv2.contourArea(contour)
        if area < image_area * 0.35:
            continue
        perimeter = cv2.arcLength(contour, True)
        approx = cv2.approxPolyDP(contour, 0.02 * perimeter, True)
        if len(approx) != 4 or not cv2.isContourConvex(approx):
            continue
        if area > best_area:
            best = approx.reshape(4, 2).astype(np.float32)
            best_area = area

    if best is None or best_area > image_area * 0.995:
        # If the quad spans ~100% of the image, perspective correction is a no-op.
        return None

    return _order_quad(best)


def warp_perspective_to_quad(image: np.ndarray, quad: np.ndarray) -> np.ndarray:
    tl, tr, br, bl = quad
    width_top = np.linalg.norm(tr - tl)
    width_bottom = np.linalg.norm(br - bl)
    height_left = np.linalg.norm(bl - tl)
    height_right = np.linalg.norm(br - tr)

    target_width = int(round(max(width_top, width_bottom)))
    target_height = int(round(max(height_left, height_right)))
    target_width = max(target_width, 16)
    target_height = max(target_height, 16)

    destination = np.array(
        [
            [0, 0],
            [target_width - 1, 0],
            [target_width - 1, target_height - 1],
            [0, target_height - 1],
        ],
        dtype=np.float32,
    )

    matrix = cv2.getPerspectiveTransform(quad, destination)
    return cv2.warpPerspective(
        image,
        matrix,
        (target_width, target_height),
        flags=cv2.INTER_CUBIC,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=(255, 255, 255),
    )


def rectify(image: np.ndarray) -> Tuple[np.ndarray, float, bool, bool]:
    """Return (rectified_image, correction_angle, perspective_applied, deskew_applied)."""
    perspective_applied = False
    working = image
    quad = detect_page_quad(image)
    if quad is not None:
        working = warp_perspective_to_quad(image, quad)
        perspective_applied = True

    binary = preprocess_for_lines(working)
    angle = estimate_dominant_angle(binary)
    deskew_applied = abs(angle) >= 0.3
    if deskew_applied:
        working = rotate_image(working, -angle)

    return working, angle, perspective_applied, deskew_applied
