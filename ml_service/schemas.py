"""Shared pydantic schemas for the ML service API."""
from __future__ import annotations

from typing import List, Optional

from pydantic import BaseModel, Field


class BoundingBoxModel(BaseModel):
    x: float
    y: float
    width: float
    height: float


class PointModel(BaseModel):
    x: float
    y: float


class ImageRequest(BaseModel):
    imageBase64: str = Field(..., min_length=8)


class RectifyResponse(BaseModel):
    imageBase64: str
    width: int
    height: int
    angle: float
    perspectiveApplied: bool
    deskewApplied: bool


class WallSegment(BaseModel):
    startPoint: PointModel
    endPoint: PointModel
    thickness: float
    confidence: float
    orientation: str  # 'horizontal' | 'vertical' | 'diagonal'


class VectorizeRequest(ImageRequest):
    downsample: Optional[int] = Field(None, ge=256, le=4096)


class VectorizeResponse(BaseModel):
    walls: List[WallSegment]
    width: int
    height: int


class OpeningSeed(BaseModel):
    position: PointModel
    width: float
    height: float
    type: str
    confidence: float
    wallIndex: Optional[int] = None


class JunctionModel(BaseModel):
    position: PointModel
    wallIndices: List[int]


class RoomPolygon(BaseModel):
    boundary: List[PointModel]
    area: float
    centroid: PointModel


class SolveRequest(BaseModel):
    width: int
    height: int
    walls: List[WallSegment]
    openings: List[OpeningSeed] = []


class SolveResponse(BaseModel):
    walls: List[WallSegment]
    openings: List[OpeningSeed]
    junctions: List[JunctionModel]
    rooms: List[RoomPolygon]


class DxfWall(BaseModel):
    startPoint: PointModel
    endPoint: PointModel
    thickness: float


class DxfOpening(BaseModel):
    position: PointModel
    width: float
    height: float
    angle: float
    type: str


class DxfDimension(BaseModel):
    startPoint: PointModel
    endPoint: PointModel
    value: float
    unit: str


class DxfText(BaseModel):
    position: PointModel
    text: str
    height: float
    angle: float = 0.0


class DxfRoom(BaseModel):
    boundary: List[PointModel]
    name: Optional[str] = None
    centroid: Optional[PointModel] = None


class ExportDxfRequest(BaseModel):
    width: int
    height: int
    scale: float = 1.0
    unit: str = "px"  # 'mm' | 'cm' | 'm' | 'in' | 'ft' | 'px'
    walls: List[DxfWall] = []
    openings: List[DxfOpening] = []
    dimensions: List[DxfDimension] = []
    texts: List[DxfText] = []
    rooms: List[DxfRoom] = []


class ExportDxfResponse(BaseModel):
    dxf: str
