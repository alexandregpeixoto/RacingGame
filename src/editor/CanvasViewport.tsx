import { useEffect, useRef } from "react";
import type { TrackDocument, TrackPath, Vec2 } from "../domain/track/types";
import { buildAllPathGeometries, buildTrackGeometry, getOpenConnectors, getModuleWorldBounds, moduleContainsPoint } from "../domain/track/geometry";
import { getThemePalette } from "../domain/track/themes";

export interface ViewportState { center: Vec2; zoom: number }

interface CanvasViewportProps {
  document: TrackDocument;
  viewport: ViewportState;
  selectedModuleId?: string;
  selectedPathPointId?: string;
  selectedPropId?: string;
  placingDefinitionId?: TrackDocument["modules"][number]["definitionId"];
  placementPreview?: Vec2;
  placementStatus?: "ready" | "snap" | "invalid";
  tool: string;
  showCenterline: boolean;
  spectatorVisible: boolean;
  testDistance: number;
  onViewportChange: (viewport: ViewportState) => void;
  onSelectModule: (moduleId?: string) => void;
  onSelectPathPoint: (pathId: string, pointId?: string) => void;
  onSelectProp: (propId?: string) => void;
  onPlaceModule: (point: Vec2) => void;
  onAddMarker: (point: Vec2) => void;
  onAddPathPoint: (point: Vec2, pathId: string) => void;
  onMovePathPoint: (pathId: string, pointId: string, point: Vec2) => void;
  onAddZone: (point: Vec2) => void;
  onAddProp: (point: Vec2) => void;
  onPlacementPreview: (point?: Vec2) => void;
  onSetSpectatorCenter: (point: Vec2) => void;
  onTerrainStroke: (point: Vec2) => void;
  onMoveModule: (moduleId: string, point: Vec2) => void;
  onMoveProp: (propId: string, point: Vec2) => void;
  onCommitMove: () => void;
  onCancelMove: () => void;
}

function path2D(points: Array<{ x: number; y: number }>, toScreen: (point: Vec2) => Vec2): Path2D {
  const path = new Path2D();
  points.forEach((point, index) => {
    const screen = toScreen(point);
    if (index === 0) path.moveTo(screen.x, screen.y);
    else path.lineTo(screen.x, screen.y);
  });
  path.closePath();
  return path;
}

function activeEditablePath(document: TrackDocument, tool: string): TrackPath | undefined {
  if (tool === "racing-line") return document.paths.find((path) => path.id === "racing-line");
  if (tool === "pit") return document.paths.find((path) => path.id === "pit");
  return undefined;
}

export function CanvasViewport(props: CanvasViewportProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ kind: "pan"; pan: Vec2; screen: Vec2 } | { kind: "module"; moduleId: string } | { kind: "path"; pathId: string; pointId: string } | { kind: "prop"; propId: string } | { kind: "terrain" } | undefined>(undefined);
  const frameRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    const canvas = canvasRef.current;
    const root = rootRef.current;
    if (!canvas || !root) return;
    const resize = () => {
      const rect = root.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, rect.width * ratio);
      canvas.height = Math.max(1, rect.height * ratio);
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      frameRef.current = requestAnimationFrame(draw);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(root);
    resize();
    return () => { observer.disconnect(); if (frameRef.current) cancelAnimationFrame(frameRef.current); };
  }, []);

  useEffect(() => {
    frameRef.current = requestAnimationFrame(draw);
    return () => { if (frameRef.current) cancelAnimationFrame(frameRef.current); };
  });

  function draw() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.width / ratio;
    const height = canvas.height / ratio;
    const palette = getThemePalette(props.document.theme);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    context.fillStyle = palette.terrain;
    context.fillRect(0, 0, width, height);
    const toScreen = (point: Vec2): Vec2 => ({ x: width / 2 + (point.x - props.viewport.center.x) * props.viewport.zoom, y: height / 2 - (point.y - props.viewport.center.y) * props.viewport.zoom });
    drawTerrain(context, toScreen);
    drawGrid(context, width, height);
    const primary = buildTrackGeometry(props.document);
    const allPaths = buildAllPathGeometries(props.document);
    if (primary) {
      const roadPoints = primary.path.leftBoundary.concat([...primary.path.rightBoundary].reverse());
      context.fillStyle = palette.road;
      context.fill(path2D(roadPoints, toScreen));
      context.strokeStyle = palette.roadEdge;
      context.lineWidth = Math.max(1, 1.5 * props.viewport.zoom);
      context.stroke(path2D(primary.path.leftBoundary, toScreen));
      context.stroke(path2D(primary.path.rightBoundary, toScreen));
      if (props.document.environment.runoff !== "grass") {
        drawPathLine(context, primary.path.leftBoundary, toScreen, palette.runoff[props.document.environment.runoff], Math.max(4, props.viewport.zoom * 5), false);
        drawPathLine(context, primary.path.rightBoundary, toScreen, palette.runoff[props.document.environment.runoff], Math.max(4, props.viewport.zoom * 5), false);
      }
      if (props.document.environment.kerb !== "none") {
        drawPathLine(context, primary.path.leftBoundary, toScreen, palette.kerbB, Math.max(3, props.viewport.zoom * 2), true);
        drawPathLine(context, primary.path.rightBoundary, toScreen, palette.kerbA, Math.max(3, props.viewport.zoom * 2), true);
      }
      if (props.document.environment.barrier !== "none") {
        drawPathLine(context, primary.path.leftBoundary, toScreen, palette.barrier, Math.max(1, props.viewport.zoom), true);
        drawPathLine(context, primary.path.rightBoundary, toScreen, palette.barrier, Math.max(1, props.viewport.zoom), true);
      }
      drawModuleOverrides(context, primary.path.samples, toScreen, palette);
      drawPathLine(context, primary.path.samples.map((sample) => sample.position), toScreen, palette.centerline, props.showCenterline ? 2 : 0, false);
      drawGridSlots(context, primary.path, toScreen);
      drawZones(context, allPaths, toScreen);
      const ghost = toScreen(primary.path.positionAtDistance(props.testDistance));
      context.fillStyle = "#ffd166";
      context.beginPath(); context.arc(ghost.x, ghost.y, 6, 0, Math.PI * 2); context.fill();
    }
    Object.entries(allPaths).forEach(([pathId, geometry]) => {
      const path = props.document.paths.find((item) => item.id === pathId);
      if (!path || path.kind === "primary-loop") return;
      const color = path.kind === "pit" ? "#ffbd61" : palette.centerline;
      drawPathLine(context, geometry.path.samples.map((sample) => sample.position), toScreen, color, path.kind === "pit" ? Math.max(3, geometry.path.samples[0]?.width ?? 6) * props.viewport.zoom : 2, path.kind === "racing-line");
      if (path.kind === "pit") drawPitBoxes(context, geometry.path, toScreen);
    });
    drawProps(context, toScreen, palette.prop);
    drawMarkers(context, primary, toScreen);
    drawControlPoints(context, toScreen);
    drawOpenConnectors(context, toScreen);
    drawModules(context, toScreen);
    drawPlacementPreview(context, toScreen);
    if (props.spectatorVisible) drawSpectatorFrame(context, toScreen);
    if (props.placingDefinitionId) {
      context.fillStyle = "#ffd166";
      context.font = "12px Inter, sans-serif";
      context.fillText(`Placing ${props.placingDefinitionId} · ${props.placementStatus ?? "ready"} — click to place`, 16, height - 18);
    }
    if (props.tool === "terrain") {
      context.fillStyle = "rgba(255,255,255,.75)";
      context.font = "11px DM Mono, monospace";
      context.fillText("Terrain sculpt mode · drag to raise terrain", 16, 22);
    }
  }

  function drawTerrain(context: CanvasRenderingContext2D, toScreen: (point: Vec2) => Vec2) {
    const terrain = props.document.terrain;
    if (!terrain) return;
    const palette = getThemePalette(props.document.theme);
    for (let y = 0; y < terrain.height; y += 1) {
      for (let x = 0; x < terrain.width; x += 1) {
        const elevation = terrain.elevations[y * terrain.width + x] ?? 0;
        const screen = toScreen({ x: terrain.origin.x + x * terrain.cellSizeMeters, y: terrain.origin.y + (y + 1) * terrain.cellSizeMeters });
        const next = toScreen({ x: terrain.origin.x + (x + 1) * terrain.cellSizeMeters, y: terrain.origin.y + y * terrain.cellSizeMeters });
        context.fillStyle = adjustColor(palette.terrain, elevation * 3);
        context.fillRect(screen.x, screen.y, Math.max(1, next.x - screen.x), Math.max(1, next.y - screen.y));
      }
    }
  }

  function drawGrid(context: CanvasRenderingContext2D, width: number, height: number) {
    const gridSize = Math.max(10, 10 * props.viewport.zoom);
    context.strokeStyle = "rgba(255,255,255,0.06)"; context.lineWidth = 1;
    for (let x = width / 2; x < width; x += gridSize) { context.beginPath(); context.moveTo(x, 0); context.lineTo(x, height); context.stroke(); }
    for (let x = width / 2 - gridSize; x > 0; x -= gridSize) { context.beginPath(); context.moveTo(x, 0); context.lineTo(x, height); context.stroke(); }
    for (let y = height / 2; y < height; y += gridSize) { context.beginPath(); context.moveTo(0, y); context.lineTo(width, y); context.stroke(); }
    for (let y = height / 2 - gridSize; y > 0; y -= gridSize) { context.beginPath(); context.moveTo(0, y); context.lineTo(width, y); context.stroke(); }
  }

  function drawPathLine(context: CanvasRenderingContext2D, points: Array<{ x: number; y: number }>, toScreen: (point: Vec2) => Vec2, color: string, lineWidth: number, dashed: boolean) {
    if (lineWidth <= 0 || points.length === 0) return;
    context.save(); context.strokeStyle = color; context.lineWidth = lineWidth; context.setLineDash(dashed ? [8, 5] : []); context.beginPath();
    points.forEach((point, index) => { const screen = toScreen(point); if (index === 0) context.moveTo(screen.x, screen.y); else context.lineTo(screen.x, screen.y); });
    context.stroke(); context.restore();
  }

  function drawGridSlots(context: CanvasRenderingContext2D, path: NonNullable<ReturnType<typeof buildTrackGeometry>>["path"], toScreen: (point: Vec2) => Vec2) {
    const start = props.document.markers.find((marker) => marker.type === "start-finish");
    if (!start) return;
    for (let index = 0; index < props.document.grid.slotCount; index += 1) {
      const sample = path.sampleAtDistance(start.location.distanceMeters - index * props.document.grid.longitudinalSpacingMeters);
      const lateral = props.document.grid.staggerPattern === "alternating" ? (index % 2 === 0 ? -1 : 1) * props.document.grid.lateralSpacingMeters / 2 : 0;
      const normal = { x: -sample.tangent.y, y: sample.tangent.x };
      const screen = toScreen({ x: sample.position.x + normal.x * lateral, y: sample.position.y + normal.y * lateral });
      context.fillStyle = "rgba(255,209,102,.75)"; context.save(); context.translate(screen.x, screen.y); context.rotate(-Math.atan2(sample.tangent.y, sample.tangent.x)); context.fillRect(-5 * props.viewport.zoom, -2.5 * props.viewport.zoom, 10 * props.viewport.zoom, 5 * props.viewport.zoom); context.restore();
    }
  }

  function drawZones(context: CanvasRenderingContext2D, geometries: Record<string, NonNullable<ReturnType<typeof buildTrackGeometry>>>, toScreen: (point: Vec2) => Vec2) {
    props.document.zones.forEach((zone) => {
      const path = geometries[zone.pathId]; if (!path) return;
      const start = path.path.wrapDistance(zone.startMeters); const end = path.path.wrapDistance(zone.endMeters);
      const samples = path.path.samples.filter((sample) => start <= end ? sample.s >= start && sample.s <= end : sample.s >= start || sample.s <= end);
      drawPathLine(context, samples.map((sample) => sample.position), toScreen, zone.type.startsWith("drs") ? "#70d7ff" : "#ffcc66", 5, true);
    });
  }

  function drawModuleOverrides(context: CanvasRenderingContext2D, samples: NonNullable<ReturnType<typeof buildTrackGeometry>>["path"]["samples"], toScreen: (point: Vec2) => Vec2, palette: ReturnType<typeof getThemePalette>) {
    const groups = new Map<string, typeof samples>();
    samples.forEach((sample) => { const module = props.document.modules.find((item) => item.id === sample.moduleId); const override = props.document.overrides.find((item) => item.targetId === sample.moduleId); const surface = override?.values.surface ?? module?.properties?.surface; if (surface) groups.set(sample.moduleId, [...(groups.get(sample.moduleId) ?? []), sample]); });
    groups.forEach((moduleSamples, moduleId) => { const module = props.document.modules.find((item) => item.id === moduleId); const override = props.document.overrides.find((item) => item.targetId === moduleId); const surface = override?.values.surface ?? module?.properties?.surface; if (surface) drawPathLine(context, moduleSamples.map((sample) => sample.position), toScreen, palette.runoff[surface], Math.max(2, (module?.properties?.widthMeters ?? moduleSamples[0]?.width ?? 10) * props.viewport.zoom * 0.7), false); });
  }

  function drawPitBoxes(context: CanvasRenderingContext2D, path: NonNullable<ReturnType<typeof buildTrackGeometry>>["path"], toScreen: (point: Vec2) => Vec2) {
    props.document.pitBoxes.forEach((box) => { const sample = path.sampleAtDistance(box.distanceMeters); const normal = { x: -sample.tangent.y, y: sample.tangent.x }; const screen = toScreen({ x: sample.position.x + normal.x * box.lateralOffsetMeters, y: sample.position.y + normal.y * box.lateralOffsetMeters }); context.fillStyle = "#ffbd61"; context.fillRect(screen.x - 5, screen.y - 3, 10, 6); });
  }

  function drawMarkers(context: CanvasRenderingContext2D, primary: ReturnType<typeof buildTrackGeometry>, toScreen: (point: Vec2) => Vec2) {
    props.document.markers.forEach((marker) => {
      const geometry = marker.location.pathId === "primary" ? primary : buildAllPathGeometries(props.document)[marker.location.pathId];
      if (!geometry) return;
      const position = toScreen(geometry.path.positionAtDistance(marker.location.distanceMeters));
      context.fillStyle = marker.type === "start-finish" ? "#f7f7f2" : marker.type.includes("pit") ? "#ffbd61" : "#ff7b9c";
      context.beginPath(); context.arc(position.x, position.y, marker.type === "start-finish" ? 7 : 5, 0, Math.PI * 2); context.fill();
    });
  }

  function drawProps(context: CanvasRenderingContext2D, toScreen: (point: Vec2) => Vec2, color: string) {
    props.document.props.forEach((prop) => {
      const point = toScreen(prop.position);
      context.save(); context.translate(point.x, point.y); context.rotate(-prop.rotation); context.scale(prop.scale, prop.scale); context.fillStyle = prop.id === props.selectedPropId ? "#fff1a8" : color;
      if (prop.type === "tree") { context.beginPath(); context.arc(0, 0, 5, 0, Math.PI * 2); context.fill(); } else if (prop.type === "barrier") context.fillRect(-8, -2, 16, 4); else context.fillRect(-4, -4, 8, 8);
      context.restore();
    });
  }

  function drawControlPoints(context: CanvasRenderingContext2D, toScreen: (point: Vec2) => Vec2) {
    const path = activeEditablePath(props.document, props.tool);
    if (!path?.controlPoints) return;
    path.controlPoints.forEach((point) => {
      const screen = toScreen(point.position); const out = toScreen({ x: point.position.x + point.outHandle.x, y: point.position.y + point.outHandle.y }); const incoming = toScreen({ x: point.position.x + point.inHandle.x, y: point.position.y + point.inHandle.y });
      context.strokeStyle = "rgba(255,209,102,.7)"; context.lineWidth = 1; context.beginPath(); context.moveTo(screen.x, screen.y); context.lineTo(out.x, out.y); context.moveTo(screen.x, screen.y); context.lineTo(incoming.x, incoming.y); context.stroke();
      context.fillStyle = point.id === props.selectedPathPointId ? "#fff1a8" : "#ffcc66"; context.beginPath(); context.arc(screen.x, screen.y, 5, 0, Math.PI * 2); context.fill();
    });
  }

  function drawOpenConnectors(context: CanvasRenderingContext2D, toScreen: (point: Vec2) => Vec2) {
    getOpenConnectors(props.document).forEach(({ connector }) => { const screen = toScreen(connector.position); context.fillStyle = "#ffcc66"; context.strokeStyle = "#101820"; context.lineWidth = 2; context.beginPath(); context.arc(screen.x, screen.y, 5, 0, Math.PI * 2); context.fill(); context.stroke(); });
  }

  function drawModules(context: CanvasRenderingContext2D, toScreen: (point: Vec2) => Vec2) {
    props.document.modules.forEach((module) => {
      const bounds = getModuleWorldBounds(module); const center = toScreen({ x: (bounds.min.x + bounds.max.x) / 2, y: (bounds.min.y + bounds.max.y) / 2 }); const selected = module.id === props.selectedModuleId;
      context.strokeStyle = selected ? "#70d7ff" : "rgba(255,255,255,.12)"; context.lineWidth = selected ? 2 : 1; context.strokeRect(center.x - Math.max(12, (bounds.max.x - bounds.min.x) * props.viewport.zoom / 2), center.y - Math.max(12, (bounds.max.y - bounds.min.y) * props.viewport.zoom / 2), Math.max(24, (bounds.max.x - bounds.min.x) * props.viewport.zoom), Math.max(24, (bounds.max.y - bounds.min.y) * props.viewport.zoom));
    });
  }

  function drawPlacementPreview(context: CanvasRenderingContext2D, toScreen: (point: Vec2) => Vec2) {
    if (!props.placingDefinitionId || !props.placementPreview) return;
    const point = toScreen(props.placementPreview);
    const color = props.placementStatus === "invalid" ? "#ff7b9c" : props.placementStatus === "snap" ? "#7fe3ad" : "#ffd166";
    context.save(); context.strokeStyle = color; context.setLineDash([5, 4]); context.lineWidth = 2; context.strokeRect(point.x - 35, point.y - 18, 70, 36); context.fillStyle = color; context.globalAlpha = 0.18; context.fillRect(point.x - 35, point.y - 18, 70, 36); context.restore();
  }

  function drawSpectatorFrame(context: CanvasRenderingContext2D, toScreen: (point: Vec2) => Vec2) {
    const frame = props.document.spectatorFrame; const topLeft = toScreen({ x: frame.center.x - frame.size.x / 2, y: frame.center.y + frame.size.y / 2 }); context.save(); context.strokeStyle = "#ffcc66"; context.setLineDash([8, 6]); context.lineWidth = 2; context.strokeRect(topLeft.x, topLeft.y, frame.size.x * props.viewport.zoom, frame.size.y * props.viewport.zoom); context.restore();
  }

  function screenToWorld(event: React.PointerEvent<HTMLCanvasElement>): Vec2 {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: (event.clientX - rect.left - rect.width / 2) / props.viewport.zoom + props.viewport.center.x, y: (rect.height / 2 - (event.clientY - rect.top)) / props.viewport.zoom + props.viewport.center.y };
  }

  function hitPathPoint(point: Vec2): { pathId: string; pointId: string } | undefined {
    const path = activeEditablePath(props.document, props.tool); const hit = path?.controlPoints?.find((item) => Math.hypot(item.position.x - point.x, item.position.y - point.y) <= 7 / props.viewport.zoom); return hit && path ? { pathId: path.id, pointId: hit.id } : undefined;
  }

  function hitProp(point: Vec2): string | undefined { return [...props.document.props].reverse().find((prop) => Math.hypot(prop.position.x - point.x, prop.position.y - point.y) <= 8 / props.viewport.zoom)?.id; }

  function onPointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    const point = screenToWorld(event);
    if (event.button === 1 || event.shiftKey) { dragRef.current = { kind: "pan", pan: props.viewport.center, screen: { x: event.clientX, y: event.clientY } }; event.currentTarget.setPointerCapture(event.pointerId); return; }
    if (props.tool === "terrain") { dragRef.current = { kind: "terrain" }; props.onTerrainStroke(point); event.currentTarget.setPointerCapture(event.pointerId); return; }
    if (props.placingDefinitionId) { props.onPlaceModule(point); return; }
    if (props.tool === "markers") { props.onAddMarker(point); return; }
    if (props.tool === "racing-line" || props.tool === "pit") {
      const hit = hitPathPoint(point);
      if (hit) { props.onSelectPathPoint(hit.pathId, hit.pointId); dragRef.current = { kind: "path", ...hit }; event.currentTarget.setPointerCapture(event.pointerId); } else props.onAddPathPoint(point, props.tool === "pit" ? "pit" : "racing-line");
      return;
    }
    if (props.tool === "zones") { props.onAddZone(point); return; }
    if (props.tool === "props") { const propId = hitProp(point); if (propId) { props.onSelectProp(propId); dragRef.current = { kind: "prop", propId }; event.currentTarget.setPointerCapture(event.pointerId); } else props.onAddProp(point); return; }
    if (props.tool === "spectator") { props.onSetSpectatorCenter(point); return; }
    const hit = [...props.document.modules].reverse().find((module) => moduleContainsPoint(module, point));
    props.onSelectModule(hit?.id);
    if (hit) { dragRef.current = { kind: "module", moduleId: hit.id }; event.currentTarget.setPointerCapture(event.pointerId); }
  }

  function onPointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    const drag = dragRef.current; if (!drag) return;
    if (drag.kind === "pan") { const dx = (event.clientX - drag.screen.x) / props.viewport.zoom; const dy = (event.clientY - drag.screen.y) / props.viewport.zoom; props.onViewportChange({ ...props.viewport, center: { x: drag.pan.x - dx, y: drag.pan.y + dy } }); return; }
    const point = screenToWorld(event);
    if (drag.kind === "module") props.onMoveModule(drag.moduleId, point);
    else if (drag.kind === "path") props.onMovePathPoint(drag.pathId, drag.pointId, point);
    else if (drag.kind === "prop") props.onMoveProp(drag.propId, point);
    else if (drag.kind === "terrain") props.onTerrainStroke(point);
  }

  function onPointerUp() { if (dragRef.current && dragRef.current.kind !== "pan") props.onCommitMove(); dragRef.current = undefined; }
  function onWheel(event: React.WheelEvent<HTMLCanvasElement>) { event.preventDefault(); props.onViewportChange({ ...props.viewport, zoom: Math.max(0.25, Math.min(15, props.viewport.zoom * (event.deltaY > 0 ? 0.9 : 1.1))) }); }

  return <div className="viewport" ref={rootRef}><canvas ref={canvasRef} onPointerDown={onPointerDown} onPointerMove={(event) => { if (props.placingDefinitionId && !dragRef.current) props.onPlacementPreview(screenToWorld(event)); onPointerMove(event); }} onPointerLeave={() => { if (props.placingDefinitionId) props.onPlacementPreview(undefined); }} onPointerUp={onPointerUp} onPointerCancel={() => { props.onCancelMove(); dragRef.current = undefined; }} onWheel={onWheel} /></div>;
}

function adjustColor(hex: string, amount: number): string {
  const value = hex.replace("#", ""); const number = Number.parseInt(value, 16);
  const r = Math.max(0, Math.min(255, (number >> 16) + amount)); const g = Math.max(0, Math.min(255, ((number >> 8) & 255) + amount)); const b = Math.max(0, Math.min(255, (number & 255) + amount));
  return `rgb(${r},${g},${b})`;
}
