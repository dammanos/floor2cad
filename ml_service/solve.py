"""Geometric constraint solver: snap walls orthogonally, build a junction
graph, and extract rooms as cycles in the planar graph."""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Iterable, List, Tuple

import networkx as nx
import numpy as np
from shapely.geometry import LineString, Point, Polygon

from .schemas import (
    JunctionModel,
    OpeningSeed,
    PointModel,
    RoomPolygon,
    WallSegment,
)


@dataclass
class _Wall:
    x1: float
    y1: float
    x2: float
    y2: float
    thickness: float
    confidence: float
    orientation: str
    index: int = 0
    node_a: int = -1
    node_b: int = -1

    def as_line(self) -> LineString:
        return LineString([(self.x1, self.y1), (self.x2, self.y2)])


def _orientation_for(dx: float, dy: float) -> str:
    if abs(dy) < abs(dx) * 0.2:
        return "horizontal"
    if abs(dx) < abs(dy) * 0.2:
        return "vertical"
    return "diagonal"


def _snap_orthogonal(walls: List[_Wall], angle_tolerance_deg: float = 6.0) -> None:
    """Snap walls whose angle is within ±tolerance of the axis to perfectly
    horizontal / vertical. Runs in place."""
    for wall in walls:
        dx = wall.x2 - wall.x1
        dy = wall.y2 - wall.y1
        if dx == 0 and dy == 0:
            continue
        angle = math.degrees(math.atan2(dy, dx)) % 180.0
        if angle < angle_tolerance_deg or angle > 180.0 - angle_tolerance_deg:
            mid_y = (wall.y1 + wall.y2) / 2.0
            wall.y1 = wall.y2 = mid_y
            wall.orientation = "horizontal"
        elif abs(angle - 90.0) < angle_tolerance_deg:
            mid_x = (wall.x1 + wall.x2) / 2.0
            wall.x1 = wall.x2 = mid_x
            wall.orientation = "vertical"
        else:
            wall.orientation = "diagonal"


def _cluster_coordinates(values: Iterable[float], tolerance: float) -> List[float]:
    sorted_values = sorted(values)
    clusters: List[List[float]] = []
    for value in sorted_values:
        if clusters and abs(value - clusters[-1][-1]) <= tolerance:
            clusters[-1].append(value)
        else:
            clusters.append([value])
    return [float(np.mean(cluster)) for cluster in clusters]


def _snap_to_grid(walls: List[_Wall], tolerance: float) -> None:
    h_levels = _cluster_coordinates(
        [(w.y1 + w.y2) / 2.0 for w in walls if w.orientation == "horizontal"],
        tolerance,
    )
    v_levels = _cluster_coordinates(
        [(w.x1 + w.x2) / 2.0 for w in walls if w.orientation == "vertical"],
        tolerance,
    )

    def nearest(levels: List[float], value: float) -> float:
        if not levels:
            return value
        return min(levels, key=lambda level: abs(level - value))

    for wall in walls:
        if wall.orientation == "horizontal" and h_levels:
            y = nearest(h_levels, (wall.y1 + wall.y2) / 2.0)
            wall.y1 = wall.y2 = y
        elif wall.orientation == "vertical" and v_levels:
            x = nearest(v_levels, (wall.x1 + wall.x2) / 2.0)
            wall.x1 = wall.x2 = x


def _build_junction_graph(
    walls: List[_Wall],
    merge_tolerance: float,
) -> Tuple[nx.Graph, List[Tuple[float, float]]]:
    """Merge endpoints within `merge_tolerance`, split walls at intersections,
    return the planar graph plus node positions."""
    graph = nx.Graph()
    positions: List[Tuple[float, float]] = []

    def add_node(x: float, y: float) -> int:
        for index, (px, py) in enumerate(positions):
            if abs(px - x) <= merge_tolerance and abs(py - y) <= merge_tolerance:
                return index
        positions.append((x, y))
        graph.add_node(len(positions) - 1, pos=(x, y))
        return len(positions) - 1

    # Collect break points per wall (including endpoints and intersections).
    break_points: List[List[Tuple[float, float]]] = [[] for _ in walls]
    for index, wall in enumerate(walls):
        break_points[index].append((wall.x1, wall.y1))
        break_points[index].append((wall.x2, wall.y2))

    for i, wall_a in enumerate(walls):
        line_a = wall_a.as_line()
        for j in range(i + 1, len(walls)):
            wall_b = walls[j]
            if wall_a.orientation == wall_b.orientation and wall_a.orientation != "diagonal":
                continue
            line_b = wall_b.as_line()
            if not line_a.intersects(line_b):
                continue
            intersection = line_a.intersection(line_b)
            if intersection.is_empty or intersection.geom_type != "Point":
                continue
            ix, iy = float(intersection.x), float(intersection.y)
            break_points[i].append((ix, iy))
            break_points[j].append((ix, iy))

    for index, wall in enumerate(walls):
        points = break_points[index]
        dx = wall.x2 - wall.x1
        dy = wall.y2 - wall.y1
        length = math.hypot(dx, dy) or 1.0
        # Project points onto the wall direction to order them.
        def project(pt: Tuple[float, float]) -> float:
            return ((pt[0] - wall.x1) * dx + (pt[1] - wall.y1) * dy) / length

        points = sorted(set(points), key=project)
        node_ids: List[int] = [add_node(px, py) for px, py in points]
        for a, b in zip(node_ids, node_ids[1:]):
            if a == b:
                continue
            graph.add_edge(a, b, wall=index, thickness=wall.thickness)

        if node_ids:
            wall.node_a = node_ids[0]
            wall.node_b = node_ids[-1]

    return graph, positions


def _extract_rooms(
    graph: nx.Graph,
    positions: List[Tuple[float, float]],
    image_bounds: Tuple[float, float],
    min_area: float,
) -> List[RoomPolygon]:
    if graph.number_of_edges() == 0:
        return []
    # Find minimum cycles in the planar graph — these are candidate rooms.
    try:
        cycles = nx.minimum_cycle_basis(graph)
    except nx.NetworkXError:
        return []

    rooms: List[RoomPolygon] = []
    width, height = image_bounds
    outer_area = width * height

    for cycle in cycles:
        if len(cycle) < 3:
            continue
        polygon = Polygon([positions[node] for node in cycle])
        if not polygon.is_valid:
            polygon = polygon.buffer(0)
            if polygon.is_empty or polygon.geom_type != "Polygon":
                continue
        area = float(polygon.area)
        if area < min_area or area > outer_area * 0.9:
            continue
        centroid = polygon.centroid
        boundary = [
            PointModel(x=float(pt[0]), y=float(pt[1]))
            for pt in polygon.exterior.coords[:-1]
        ]
        rooms.append(
            RoomPolygon(
                boundary=boundary,
                area=area,
                centroid=PointModel(x=float(centroid.x), y=float(centroid.y)),
            )
        )

    rooms.sort(key=lambda room: -room.area)
    return rooms


def _prune_dangles(graph: nx.Graph, min_edge_length: float) -> None:
    changed = True
    while changed:
        changed = False
        for node in list(graph.nodes):
            if graph.degree[node] != 1:
                continue
            neighbor = next(iter(graph.neighbors(node)))
            px, py = graph.nodes[node]["pos"]
            nx_, ny_ = graph.nodes[neighbor]["pos"]
            if math.hypot(px - nx_, py - ny_) < min_edge_length:
                graph.remove_node(node)
                changed = True


def _assign_openings_to_walls(
    walls: List[_Wall],
    openings: List[OpeningSeed],
) -> List[OpeningSeed]:
    if not walls or not openings:
        return openings
    updated: List[OpeningSeed] = []
    for opening in openings:
        best_index = opening.wallIndex
        best_distance = float("inf") if best_index is None else 0.0
        if best_index is None:
            op_point = Point(opening.position.x, opening.position.y)
            for index, wall in enumerate(walls):
                distance = op_point.distance(wall.as_line())
                if distance < best_distance:
                    best_distance = distance
                    best_index = index
        updated.append(
            OpeningSeed(
                position=opening.position,
                width=opening.width,
                height=opening.height,
                type=opening.type,
                confidence=opening.confidence,
                wallIndex=best_index,
            )
        )
    return updated


def solve(
    width: int,
    height: int,
    walls_in: List[WallSegment],
    openings_in: List[OpeningSeed],
) -> Tuple[
    List[WallSegment],
    List[OpeningSeed],
    List[JunctionModel],
    List[RoomPolygon],
]:
    walls = [
        _Wall(
            x1=w.startPoint.x,
            y1=w.startPoint.y,
            x2=w.endPoint.x,
            y2=w.endPoint.y,
            thickness=w.thickness,
            confidence=w.confidence,
            orientation=w.orientation,
            index=index,
        )
        for index, w in enumerate(walls_in)
    ]

    if not walls:
        return [], openings_in, [], []

    thickness_median = float(np.median([w.thickness for w in walls]))
    snap_tolerance = max(4.0, thickness_median * 0.75)

    _snap_orthogonal(walls)
    _snap_to_grid(walls, snap_tolerance)

    graph, positions = _build_junction_graph(walls, merge_tolerance=snap_tolerance)
    _prune_dangles(graph, min_edge_length=max(12.0, thickness_median * 2.0))

    # Rebuild wall output from remaining graph edges, grouped by source wall index.
    wall_edges: dict[int, List[Tuple[int, int]]] = {}
    for a, b, data in graph.edges(data=True):
        wall_edges.setdefault(data["wall"], []).append((a, b))

    resolved: List[WallSegment] = []
    for index, wall in enumerate(walls):
        edges = wall_edges.get(index, [])
        if not edges:
            continue
        for node_a, node_b in edges:
            p1 = positions[node_a]
            p2 = positions[node_b]
            dx = p2[0] - p1[0]
            dy = p2[1] - p1[1]
            length = math.hypot(dx, dy)
            if length < max(12.0, wall.thickness * 2.0):
                continue
            resolved.append(
                WallSegment(
                    startPoint=PointModel(x=float(p1[0]), y=float(p1[1])),
                    endPoint=PointModel(x=float(p2[0]), y=float(p2[1])),
                    thickness=float(wall.thickness),
                    confidence=float(min(0.98, wall.confidence + 0.03)),
                    orientation=_orientation_for(dx, dy),
                )
            )

    junctions: List[JunctionModel] = []
    for node in graph.nodes:
        if graph.degree[node] < 2:
            continue
        px, py = graph.nodes[node]["pos"]
        incident = sorted({
            data["wall"] for _, _, data in graph.edges(node, data=True)
        })
        junctions.append(
            JunctionModel(
                position=PointModel(x=float(px), y=float(py)),
                wallIndices=incident,
            )
        )

    rooms = _extract_rooms(
        graph,
        positions,
        image_bounds=(float(width), float(height)),
        min_area=max(400.0, width * height * 0.0015),
    )
    openings_out = _assign_openings_to_walls(walls, openings_in)

    return resolved, openings_out, junctions, rooms
