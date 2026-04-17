"""DXF export powered by ezdxf.

Emits real geometry with proper layers, blocks for doors/windows, and
AcDbAlignedDimension entities so CAD users get live dimensions.
"""
from __future__ import annotations

import io
import math
from typing import Tuple

import ezdxf
from ezdxf import units as ezunits
from ezdxf.document import Drawing

from .schemas import ExportDxfRequest


_UNIT_MAP = {
    "mm": ezunits.MM,
    "cm": ezunits.CM,
    "m": ezunits.M,
    "in": ezunits.IN,
    "ft": ezunits.FT,
    "px": ezunits.M,  # fall through to meters so INSUNITS is always defined
}


LAYER_DEFS = [
    ("WALLS", 7),
    ("WALL_FILL", 2),
    ("OPENINGS", 4),
    ("DOORS", 4),
    ("WINDOWS", 5),
    ("ROOMS", 3),
    ("ROOM_LABELS", 3),
    ("FURNITURE", 6),
    ("DIMENSIONS", 1),
    ("DIMENSION_TEXT", 1),
    ("TEXT", 5),
]


def _ensure_blocks(doc: Drawing) -> None:
    if "DOOR" not in doc.blocks:
        block = doc.blocks.new(name="DOOR")
        # Unit-length door: hinge at origin, swing arc toward +Y.
        block.add_line((0, 0), (1, 0), dxfattribs={"layer": "DOORS"})
        block.add_arc(
            center=(0, 0),
            radius=1.0,
            start_angle=0,
            end_angle=90,
            dxfattribs={"layer": "DOORS"},
        )

    if "WINDOW" not in doc.blocks:
        block = doc.blocks.new(name="WINDOW")
        # Window: two parallel lines spanning the opening width.
        block.add_line((0, -0.5), (1, -0.5), dxfattribs={"layer": "WINDOWS"})
        block.add_line((0, 0.5), (1, 0.5), dxfattribs={"layer": "WINDOWS"})
        block.add_line((0, -0.5), (0, 0.5), dxfattribs={"layer": "WINDOWS"})
        block.add_line((1, -0.5), (1, 0.5), dxfattribs={"layer": "WINDOWS"})


def _transform(point, height: float, scale: float) -> Tuple[float, float]:
    # Pixel space has y-down; DXF has y-up. Flip then scale.
    return (point.x * scale, (height - point.y) * scale)


def export(request: ExportDxfRequest) -> str:
    unit = request.unit if request.unit in _UNIT_MAP else "px"
    scale = request.scale if request.scale and request.scale > 0 else 1.0
    if unit == "px":
        scale = 1.0

    doc = ezdxf.new(dxfversion="R2018", setup=True)
    doc.units = _UNIT_MAP[unit]
    doc.header["$INSUNITS"] = doc.units
    msp = doc.modelspace()

    for name, color in LAYER_DEFS:
        if name not in doc.layers:
            doc.layers.add(name=name, color=color)

    _ensure_blocks(doc)

    height = float(request.height)

    for wall in request.walls:
        sp = _transform(wall.startPoint, height, scale)
        ep = _transform(wall.endPoint, height, scale)
        msp.add_line(sp, ep, dxfattribs={"layer": "WALLS"})
        if wall.thickness > 1:
            dx = ep[0] - sp[0]
            dy = ep[1] - sp[1]
            length = math.hypot(dx, dy)
            if length > 0:
                half_t = (wall.thickness * scale) / 2.0
                nx = (-dy / length) * half_t
                ny = (dx / length) * half_t
                msp.add_lwpolyline(
                    [
                        (sp[0] + nx, sp[1] + ny),
                        (ep[0] + nx, ep[1] + ny),
                        (ep[0] - nx, ep[1] - ny),
                        (sp[0] - nx, sp[1] - ny),
                    ],
                    close=True,
                    dxfattribs={"layer": "WALL_FILL"},
                )

    for opening in request.openings:
        center = _transform(opening.position, height, scale)
        width = opening.width * scale
        block_name = "DOOR" if "door" in opening.type else "WINDOW"
        rotation = -opening.angle  # opening.angle is measured in image space (y-down).
        msp.add_blockref(
            block_name,
            insert=(center[0] - width / 2.0, center[1]),
            dxfattribs={
                "xscale": width,
                "yscale": width,
                "zscale": 1,
                "rotation": rotation,
                "layer": "DOORS" if block_name == "DOOR" else "WINDOWS",
            },
        )

    for dimension in request.dimensions:
        p1 = _transform(dimension.startPoint, height, scale)
        p2 = _transform(dimension.endPoint, height, scale)
        offset = max(6.0, 12.0 * scale)
        dim = msp.add_aligned_dim(
            p1=p1,
            p2=p2,
            distance=offset,
            dxfattribs={"layer": "DIMENSIONS"},
        )
        dim.render()

    for room in request.rooms:
        if len(room.boundary) < 3:
            continue
        points = [_transform(pt, height, scale) for pt in room.boundary]
        msp.add_lwpolyline(points, close=True, dxfattribs={"layer": "ROOMS"})
        if room.name:
            centroid = room.centroid or room.boundary[0]
            cp = _transform(centroid, height, scale)
            text = msp.add_text(
                room.name,
                dxfattribs={"layer": "ROOM_LABELS", "height": 3.0 * scale},
            )
            text.set_placement(cp, align=ezdxf.enums.TextEntityAlignment.MIDDLE_CENTER)

    for text in request.texts:
        point = _transform(text.position, height, scale)
        entity = msp.add_text(
            text.text,
            dxfattribs={
                "layer": "TEXT",
                "height": max(1.5, text.height * scale),
                "rotation": -text.angle,  # image space → DXF space
            },
        )
        entity.set_placement(point, align=ezdxf.enums.TextEntityAlignment.LEFT)

    buffer = io.StringIO()
    doc.write(buffer)
    return buffer.getvalue()
