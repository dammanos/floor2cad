from __future__ import annotations

import base64
import io
import math
import os
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np
from fastapi import FastAPI, HTTPException
from PIL import Image
from pydantic import BaseModel, Field

try:
    from paddleocr import PaddleOCR
except ImportError:  # pragma: no cover - optional dependency
    PaddleOCR = None  # type: ignore[assignment]

try:
    from rapidocr_onnxruntime import RapidOCR
except ImportError:  # pragma: no cover - optional dependency
    RapidOCR = None  # type: ignore[assignment]

try:
    from ultralytics import YOLO
except ImportError:  # pragma: no cover - optional dependency
    YOLO = None  # type: ignore[assignment]

try:
    import torch
    import torch.nn.functional as F
    from transformers import AutoImageProcessor, AutoModelForSemanticSegmentation
except ImportError:  # pragma: no cover - optional dependency
    torch = None  # type: ignore[assignment]
    F = None  # type: ignore[assignment]
    AutoImageProcessor = None  # type: ignore[assignment]
    AutoModelForSemanticSegmentation = None  # type: ignore[assignment]

app = FastAPI(title='Floor2CAD ML Service', version='0.1.0')


class BoundingBoxModel(BaseModel):
    x: int
    y: int
    width: int
    height: int


class ImageRequest(BaseModel):
    imageBase64: str = Field(..., min_length=8)


class OCRTextElement(BaseModel):
    x: float
    y: float
    text: str
    confidence: float
    boundingBox: BoundingBoxModel
    angle: float = 0.0
    category: str = 'unknown'


class OCRResponse(BaseModel):
    engine: str
    textElements: List[OCRTextElement]


class SymbolRequest(ImageRequest):
    confidenceThreshold: float = Field(0.25, ge=0.01, le=0.99)
    labels: Optional[List[str]] = None


class SymbolPrediction(BaseModel):
    label: str
    confidence: float
    boundingBox: BoundingBoxModel
    angle: float = 0.0


class SymbolResponse(BaseModel):
    model: str
    predictions: List[SymbolPrediction]


class SegmentationRegion(BaseModel):
    label: str
    coverage: float
    boundingBox: BoundingBoxModel


class SegmentationResponse(BaseModel):
    model: str
    regions: List[SegmentationRegion]


@lru_cache(maxsize=1)
def get_ocr_engine() -> Any:
    backend = os.getenv('ML_OCR_BACKEND', 'rapidocr').strip().lower()

    if backend == 'paddle':
        if PaddleOCR is None:
            raise RuntimeError('paddleocr is not installed')

        return PaddleOCR(
            use_angle_cls=True,
            lang=os.getenv('ML_OCR_LANG', 'en'),
            show_log=False,
        )

    if RapidOCR is None:
        raise RuntimeError('rapidocr_onnxruntime is not installed')

    return RapidOCR()


@lru_cache(maxsize=1)
def get_symbol_model() -> Any:
    model_path = os.getenv('ML_SYMBOL_MODEL_PATH')
    if YOLO is None:
        raise RuntimeError('ultralytics is not installed')
    if not model_path:
        raise RuntimeError('ML_SYMBOL_MODEL_PATH is not set')
    if not Path(model_path).exists():
        raise RuntimeError(f'symbol model not found: {model_path}')

    return YOLO(model_path)


@lru_cache(maxsize=1)
def get_segmentation_bundle() -> Any:
    model_name = os.getenv('ML_SEGMENTATION_MODEL')
    if AutoImageProcessor is None or AutoModelForSemanticSegmentation is None or torch is None:
        raise RuntimeError('transformers/torch are not installed')
    if not model_name:
        raise RuntimeError('ML_SEGMENTATION_MODEL is not set')

    processor = AutoImageProcessor.from_pretrained(model_name)
    model = AutoModelForSemanticSegmentation.from_pretrained(model_name)
    model.eval()
    return processor, model


@app.get('/health')
def health() -> Dict[str, Any]:
    return {
        'status': 'ok',
        'ocr': {
            'enabled': os.getenv('ML_OCR_ENABLED', 'false').lower() in {'1', 'true', 'yes', 'on'},
            'backendInstalled': PaddleOCR is not None or RapidOCR is not None,
        },
        'symbols': {
            'enabled': os.getenv('ML_SYMBOLS_ENABLED', 'false').lower() in {'1', 'true', 'yes', 'on'},
            'backendInstalled': YOLO is not None,
            'modelPath': os.getenv('ML_SYMBOL_MODEL_PATH'),
        },
        'segmentation': {
            'enabled': os.getenv('ML_SEGMENTATION_ENABLED', 'false').lower() in {'1', 'true', 'yes', 'on'},
            'backendInstalled': AutoImageProcessor is not None and AutoModelForSemanticSegmentation is not None,
            'model': os.getenv('ML_SEGMENTATION_MODEL'),
        },
    }


@app.post('/ocr', response_model=OCRResponse)
def ocr(request: ImageRequest) -> OCRResponse:
    try:
        engine = get_ocr_engine()
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error

    image = decode_image(request.imageBase64)
    text_elements: List[OCRTextElement] = []

    if PaddleOCR is not None and isinstance(engine, PaddleOCR):
        result = engine.ocr(np.array(image.convert('RGB')), cls=True)

        for page in result or []:
            for entry in page or []:
                if len(entry) < 2:
                    continue

                polygon, payload = entry
                if not polygon or not payload:
                    continue

                text = str(payload[0]).strip()
                confidence = float(payload[1]) if len(payload) > 1 else 0.0
                if not text:
                    continue

                box = polygon_to_box(polygon)
                text_elements.append(
                    OCRTextElement(
                        x=box.x + box.width / 2,
                        y=box.y + box.height / 2,
                        text=text,
                        confidence=max(0.0, min(1.0, confidence)),
                        boundingBox=box,
                        angle=polygon_angle(polygon),
                        category=classify_text(text),
                    )
                )
    else:
        result, _ = engine(np.array(image.convert('RGB')))
        for entry in result or []:
            if len(entry) < 3:
                continue

            points, text, confidence = entry[0], entry[1], entry[2]
            if not text:
                continue

            box = polygon_to_box(points)
            text_elements.append(
                OCRTextElement(
                    x=box.x + box.width / 2,
                    y=box.y + box.height / 2,
                    text=str(text).strip(),
                    confidence=max(0.0, min(1.0, float(confidence))),
                    boundingBox=box,
                    angle=polygon_angle(points),
                    category=classify_text(str(text)),
                )
            )

    engine_name = 'paddleocr' if PaddleOCR is not None and isinstance(engine, PaddleOCR) else 'rapidocr'
    return OCRResponse(engine=engine_name, textElements=text_elements)


@app.post('/detect-symbols', response_model=SymbolResponse)
def detect_symbols(request: SymbolRequest) -> SymbolResponse:
    try:
        model = get_symbol_model()
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error

    image = np.array(decode_image(request.imageBase64).convert('RGB'))
    label_filter = {normalize_label(label) for label in request.labels or []}
    predictions: List[SymbolPrediction] = []

    results = model.predict(source=image, conf=request.confidenceThreshold, verbose=False)
    for result in results:
        names = result.names if isinstance(result.names, dict) else getattr(model, 'names', {})
        boxes = result.boxes if result.boxes is not None else []
        for box in boxes:
            class_id = int(box.cls[0].item())
            raw_label = names[class_id] if isinstance(names, dict) else str(class_id)
            label = normalize_label(str(raw_label))
            if label_filter and label not in label_filter:
                continue

            x1, y1, x2, y2 = [float(value) for value in box.xyxy[0].tolist()]
            predictions.append(
                SymbolPrediction(
                    label=label,
                    confidence=float(box.conf[0].item()),
                    boundingBox=BoundingBoxModel(
                        x=int(round(x1)),
                        y=int(round(y1)),
                        width=max(1, int(round(x2 - x1))),
                        height=max(1, int(round(y2 - y1))),
                    ),
                )
            )

    return SymbolResponse(
        model=os.getenv('ML_SYMBOL_MODEL_PATH', 'ultralytics'),
        predictions=predictions,
    )


@app.post('/segment', response_model=SegmentationResponse)
def segment(request: ImageRequest) -> SegmentationResponse:
    try:
        processor, model = get_segmentation_bundle()
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error

    if torch is None or F is None:
        raise HTTPException(status_code=503, detail='transformers/torch are not installed')

    image = decode_image(request.imageBase64).convert('RGB')
    inputs = processor(images=image, return_tensors='pt')

    with torch.no_grad():
        outputs = model(**inputs)

    logits = F.interpolate(
        outputs.logits,
        size=(image.height, image.width),
        mode='bilinear',
        align_corners=False,
    )
    mask = logits.argmax(dim=1)[0].cpu().numpy()
    id2label = getattr(model.config, 'id2label', {})
    regions: List[SegmentationRegion] = []

    for class_id in np.unique(mask):
        label = normalize_label(str(id2label.get(int(class_id), class_id)))
        if label in {'background', 'bg', '0'}:
            continue

        ys, xs = np.where(mask == class_id)
        if len(xs) == 0 or len(ys) == 0:
            continue

        regions.append(
            SegmentationRegion(
                label=label,
                coverage=float(len(xs) / mask.size),
                boundingBox=BoundingBoxModel(
                    x=int(xs.min()),
                    y=int(ys.min()),
                    width=max(1, int(xs.max() - xs.min() + 1)),
                    height=max(1, int(ys.max() - ys.min() + 1)),
                ),
            )
        )

    return SegmentationResponse(
        model=os.getenv('ML_SEGMENTATION_MODEL', 'transformers'),
        regions=regions,
    )


def decode_image(image_base64: str) -> Image.Image:
    try:
        raw = base64.b64decode(image_base64)
        return Image.open(io.BytesIO(raw))
    except Exception as error:  # pragma: no cover - invalid input path
        raise HTTPException(status_code=400, detail=f'invalid image payload: {error}') from error


def polygon_to_box(points: List[List[float]]) -> BoundingBoxModel:
    xs = [point[0] for point in points]
    ys = [point[1] for point in points]
    return BoundingBoxModel(
        x=int(round(min(xs))),
        y=int(round(min(ys))),
        width=max(1, int(round(max(xs) - min(xs)))),
        height=max(1, int(round(max(ys) - min(ys)))),
    )


def polygon_angle(points: List[List[float]]) -> float:
    if len(points) < 2:
        return 0.0

    x0, y0 = points[0]
    x1, y1 = points[1]
    return math.degrees(math.atan2(y1 - y0, x1 - x0))


def classify_text(text: str) -> str:
    normalized = text.strip().lower()
    if any(unit in normalized for unit in ('mm', 'cm', ' m', 'ft', 'in', '"', "'")):
        return 'dimension'
    if any(keyword in normalized for keyword in ('kitchen', 'bed', 'bath', 'living', 'hall', 'office', 'closet', 'wc', 'toilet', 'laundry')):
        return 'room'
    if normalized:
        return 'label'
    return 'unknown'


def normalize_label(label: str) -> str:
    return label.strip().lower().replace('-', '_').replace(' ', '_')
