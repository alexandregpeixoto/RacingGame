import { useEffect, useMemo, useRef } from "react";
import type {
  TrackDocument,
  TrackModule,
  TrackPath,
  Vec2,
} from "../domain/track/types";
import {
  buildAllPathGeometries,
  buildTrackGeometry,
  getOpenConnectors,
  getModuleWorldBounds,
  moduleContainsPoint,
  isPointDrivable,
  buildModulePath,
  buildModulePaths,
  effectiveModule,
} from "../domain/track/geometry";
import { generateGrid } from "../domain/track/authoring";
import { rotate } from "../domain/track/math";
import { raceCameraLayout } from "./raceCamera";
import { resolvedFacility } from "../domain/track/catalog";
import { getThemePalette } from "../domain/track/themes";

export interface ViewportState {
  center: Vec2;
  zoom: number;
}

interface CanvasViewportProps {
  document: TrackDocument;
  viewport: ViewportState;
  selectedModuleId?: string;
  selectedPathPointId?: string;
  selectedPropId?: string;
  placingDefinitionId?: TrackDocument["modules"][number]["definitionId"];
  placementPreview?: Vec2;
  placementStatus?: "ready" | "snap" | "invalid";
  placementModule?: TrackModule;
  spectatorPreview?: boolean;
  tool: string;
  showCenterline: boolean;
  spectatorVisible: boolean;
  testDistance: number;
  testPathId?: string;
  penPoints?: Vec2[];
  onViewportChange: (viewport: ViewportState) => void;
  onSelectModule: (moduleId?: string) => void;
  onSelectPathPoint: (pathId: string, pointId?: string) => void;
  onSelectProp: (propId?: string) => void;
  onPlaceModule: (point: Vec2) => void;
  onAddMarker: (point: Vec2) => void;
  onAddPathPoint: (point: Vec2, pathId: string) => void;
  onMovePathHandle?: (
    pathId: string,
    pointId: string,
    handle: "inHandle" | "outHandle",
    point: Vec2,
  ) => void;
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

function path2D(
  points: Array<{ x: number; y: number }>,
  toScreen: (point: Vec2) => Vec2,
): Path2D {
  const path = new Path2D();
  points.forEach((point, index) => {
    const screen = toScreen(point);
    if (index === 0) path.moveTo(screen.x, screen.y);
    else path.lineTo(screen.x, screen.y);
  });
  path.closePath();
  return path;
}

function activeEditablePath(
  document: TrackDocument,
  tool: string,
  moduleId?: string,
): TrackPath | undefined {
  const module = document.modules.find((m) => m.id === moduleId);
  if (module?.controlPoints)
    return {
      id: "module:" + module.id,
      kind: "secondary",
      closed: false,
      sourceModuleIds: [],
      controlPoints: module.controlPoints.map((p) => {
        const position = rotate(p.position, module.transform.rotation);
        return {
          ...p,
          position: {
            x: position.x + module.transform.position.x,
            y: position.y + module.transform.position.y,
            z: p.position.z + module.transform.position.z,
          },
          inHandle: rotate(p.inHandle, module.transform.rotation),
          outHandle: rotate(p.outHandle, module.transform.rotation),
        };
      }),
    };
  if (tool === "racing-line")
    return document.paths.find((path) => path.id === "racing-line");
  if (tool === "pit") return document.paths.find((path) => path.kind === "pit");
  return undefined;
}

export function CanvasViewport(props: CanvasViewportProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<
    | { kind: "pan"; pan: Vec2; screen: Vec2 }
    | { kind: "module"; moduleId: string; offset: Vec2 }
    | {
        kind: "path";
        pathId: string;
        pointId: string;
        handle?: "inHandle" | "outHandle";
      }
    | { kind: "prop"; propId: string }
    | { kind: "terrain" }
    | undefined
  >(undefined);
  const spaceRef = useRef(false);
  const primary = useMemo(
    () => buildTrackGeometry(props.document),
    [props.document],
  );
  const allPaths = useMemo(
    () => buildAllPathGeometries(props.document),
    [props.document],
  );
  const modulePaths = useMemo(
    () =>
      props.document.modules
        .flatMap((module) => {
          const effective = effectiveModule(props.document, module);
          return buildModulePaths(effective).map((path) => ({
            module: effective,
            path,
          }));
        })
        .sort(
          (a, b) =>
            Math.max(...a.path.samples.map((s) => s.position.z)) -
            Math.max(...b.path.samples.map((s) => s.position.z)),
        ),
    [props.document],
  );
  const drawRef = useRef<() => void>(() => undefined);
  drawRef.current = draw;
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
      frameRef.current = requestAnimationFrame(() => drawRef.current());
    };
    const observer = new ResizeObserver(resize);
    observer.observe(root);
    resize();
    return () => {
      observer.disconnect();
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    };
  }, []);

  useEffect(() => {
    frameRef.current = requestAnimationFrame(() => drawRef.current());
    return () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    };
  });

  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => {
      if (
        (event.target as HTMLElement)?.closest(
          "input, textarea, select, [contenteditable=true]",
        )
      )
        return;
      if (event.code === "Space") {
        spaceRef.current = true;
        event.preventDefault();
      }
      if (event.key === "Escape") {
        props.onCancelMove();
        dragRef.current = undefined;
      }
    };
    const keyUp = (event: KeyboardEvent) => {
      if (event.code === "Space") spaceRef.current = false;
    };
    const blur = () => {
      spaceRef.current = false;
      if (dragRef.current) props.onCancelMove();
      dragRef.current = undefined;
    };
    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
      window.removeEventListener("blur", blur);
    };
  });

  function camera(width: number, height: number) {
    const frame = props.document.spectatorFrame;
    return props.spectatorPreview
      ? raceCameraLayout(frame, width, height)
      : {
          ...props.viewport,
          rotation: 0,
          screenCenter: { x: width / 2, y: height / 2 },
        };
  }
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
    context.fillStyle = props.spectatorPreview ? "#080d12" : palette.terrain;
    context.fillRect(0, 0, width, height);
    const view = camera(width, height);
    const toScreen = (point: Vec2): Vec2 => {
      const local = rotate(
        { x: point.x - view.center.x, y: point.y - view.center.y },
        -view.rotation,
      );
      return {
        x: view.screenCenter.x + local.x * view.zoom,
        y: view.screenCenter.y - local.y * view.zoom,
      };
    };
    context.save();
    if (props.spectatorPreview) {
      const frame = props.document.spectatorFrame;
      context.beginPath();
      context.rect(
        view.screenCenter.x - (frame.size.x * view.zoom) / 2,
        view.screenCenter.y - (frame.size.y * view.zoom) / 2,
        frame.size.x * view.zoom,
        frame.size.y * view.zoom,
      );
      context.clip();
      context.fillStyle = palette.terrain;
      context.fillRect(0, 0, width, height);
    }
    drawTerrain(context, toScreen);
    drawGrid(context, width, height);
    const pitGeometries = props.document.paths
      .filter((path) => path.kind === "pit" && path.sourceModuleIds.length)
      .flatMap((path) => (allPaths[path.id] ? [allPaths[path.id]] : []));
    // Draw authored modules even while the graph is open. Collision uses these same strips.
    modulePaths.forEach(({ module, path }) => {
      const isPit = props.document.paths.some(
        (owner) =>
          owner.kind === "pit" && owner.sourceModuleIds.includes(module.id),
      );
      const outsidePitJunction = (point: Vec2) =>
        !modulePaths.some(
          (other) =>
            other.module.id === module.id &&
            other.path !== path &&
            isPointDrivable(other.path, point),
        ) &&
        (isPit ||
          !pitGeometries.some((geometry) =>
            isPointDrivable(geometry.path, point),
          ));
      const surface = module.properties?.surface;
      const points = path.leftBoundary.concat(
        [...path.rightBoundary].reverse(),
      );
      if (!isPit && props.document.environment.runoff !== "grass")
        for (const boundary of [path.leftBoundary, path.rightBoundary])
          drawPathLine(
            context,
            boundary,
            toScreen,
            palette.runoff[props.document.environment.runoff],
            view.zoom * 5,
            false,
          );
      context.fillStyle = surface ? palette.runoff[surface] : palette.road;
      context.save();
      if (module.definitionId === "overpass") {
        context.shadowColor = "rgba(0,0,0,.6)";
        context.shadowBlur = 6;
        context.shadowOffsetY = 4;
      }
      context.fill(path2D(points, toScreen));
      context.restore();
      if (!isPit && props.document.environment.barrier !== "none") {
        for (const sign of [-1, 1]) {
          const boundary = path.samples.map((sample) => {
            const magnitude =
              Math.hypot(sample.tangent.x, sample.tangent.y) || 1;
            return {
              x:
                sample.position.x -
                (sample.tangent.y / magnitude) *
                  ((sign > 0 ? sample.leftWidth : sample.rightWidth) ??
                    sample.width / 2) *
                  sign -
                (sample.tangent.y / magnitude) * 3 * sign,
              y:
                sample.position.y +
                (sample.tangent.x / magnitude) *
                  (((sign > 0 ? sample.leftWidth : sample.rightWidth) ??
                    sample.width / 2) +
                    3) *
                  sign,
            };
          });
          drawPathLine(
            context,
            boundary,
            toScreen,
            palette.barrier,
            Math.max(1, view.zoom * 0.25),
            props.document.environment.barrier !== "wall",
            outsidePitJunction,
          );
        }
      }
      for (const boundary of [path.leftBoundary, path.rightBoundary]) {
        drawPathLine(
          context,
          boundary,
          toScreen,
          isPit ? "#e6b467" : palette.roadEdge,
          Math.max(1, view.zoom * 0.3),
          false,
          outsidePitJunction,
        );
        const kerb =
          module.properties?.kerb ??
          (isPit ? "none" : props.document.environment.kerb);
        if (kerb !== "none") {
          const colors =
            kerb === "blue-white"
              ? ["#3078d5", "#ffffff"]
              : kerb === "yellow-black"
                ? ["#ffd166", "#182027"]
                : [palette.kerbB, palette.kerbA];
          drawPathLine(
            context,
            boundary,
            toScreen,
            colors[0],
            Math.max(2, view.zoom * 0.65),
            false,
            outsidePitJunction,
          );
          drawPathLine(
            context,
            boundary,
            toScreen,
            colors[1],
            Math.max(2, view.zoom * 0.65),
            true,
            outsidePitJunction,
          );
        }
      }
      if (
        ["overpass", "underpass"].includes(module.definitionId) &&
        !props.spectatorPreview
      ) {
        const midpoint = toScreen(
          path.positionAtDistance(path.totalLengthMeters / 2),
        );
        context.font = "11px monospace";
        context.fillStyle = "#a8e2ff";
        context.fillText(
          `${module.definitionId === "overpass" ? "↑" : "↓"} ${module.parameters.rise ?? 6}m`,
          midpoint.x + 5,
          midpoint.y - 10,
        );
      }
    });
    if (primary) {
      drawPathLine(
        context,
        primary.path.samples.map((sample) => sample.position),
        toScreen,
        palette.centerline,
        props.showCenterline && !props.spectatorPreview ? 2 : 0,
        false,
      );
      drawGridSlots(context, primary.path, toScreen);
      drawZones(context, allPaths, toScreen);
      const ghost = toScreen(
        (
          allPaths[props.testPathId ?? "primary"] ?? primary
        ).path.positionAtDistance(props.testDistance),
      );
      if (props.tool === "test") {
        context.fillStyle = "#ffd166";
        context.beginPath();
        context.arc(ghost.x, ghost.y, 6, 0, Math.PI * 2);
        context.fill();
      }
    }
    Object.entries(allPaths).forEach(([pathId, geometry]) => {
      const path = props.document.paths.find((item) => item.id === pathId);
      if (!path || path.kind === "primary-loop") return;
      const color = path.kind === "pit" ? "#ffbd61" : palette.centerline;
      drawPathLine(
        context,
        geometry.path.samples.map((sample) => sample.position),
        toScreen,
        color,
        path.kind === "pit" && !path.sourceModuleIds.length
          ? Math.max(3, geometry.path.samples[0]?.width ?? 6) * view.zoom
          : props.spectatorPreview
            ? 0
            : 1.5,
        path.kind === "racing-line" || path.kind === "pit",
      );
      if (path.kind === "pit")
        drawPitBoxes(context, geometry.path, toScreen, path.id);
    });
    drawProps(context, toScreen, palette.prop);
    drawMarkers(context, primary, toScreen);
    if (!props.spectatorPreview) {
      drawControlPoints(context, toScreen);
      drawOpenConnectors(context, toScreen);
      drawModules(context, toScreen);
      drawPlacementPreview(context, toScreen);
      if (props.penPoints?.length)
        drawPathLine(context, props.penPoints, toScreen, "#70d7ff", 3, false);
    }
    context.restore();
    if (props.spectatorVisible || props.spectatorPreview)
      drawSpectatorFrame(context, toScreen);
    if (props.placingDefinitionId) {
      context.fillStyle = "#ffd166";
      context.font = "12px Inter, sans-serif";
      context.fillText(
        `Placing ${props.placingDefinitionId} · ${props.placementStatus ?? "ready"} — click to place`,
        16,
        height - 18,
      );
    }
    if (props.tool === "terrain") {
      context.fillStyle = "rgba(255,255,255,.75)";
      context.font = "11px DM Mono, monospace";
      context.fillText("Terrain sculpt mode · drag to raise terrain", 16, 22);
    }
  }

  function drawTerrain(
    context: CanvasRenderingContext2D,
    toScreen: (point: Vec2) => Vec2,
  ) {
    const terrain = props.document.terrain;
    if (!terrain) return;
    const palette = getThemePalette(props.document.theme);
    for (let y = 0; y < terrain.height; y += 1) {
      for (let x = 0; x < terrain.width; x += 1) {
        const elevation = terrain.elevations[y * terrain.width + x] ?? 0;
        const x0 = terrain.origin.x + x * terrain.cellSizeMeters,
          y0 = terrain.origin.y + y * terrain.cellSizeMeters;
        context.fillStyle = adjustColor(palette.terrain, elevation * 3);
        context.fill(
          path2D(
            [
              { x: x0, y: y0 },
              { x: x0 + terrain.cellSizeMeters, y: y0 },
              {
                x: x0 + terrain.cellSizeMeters,
                y: y0 + terrain.cellSizeMeters,
              },
              { x: x0, y: y0 + terrain.cellSizeMeters },
            ],
            toScreen,
          ),
        );
      }
    }
  }

  function drawGrid(
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
  ) {
    if (props.spectatorPreview) return;
    const gridSize = 10 * props.viewport.zoom;
    if (gridSize < 4) return;
    const originX = width / 2 - props.viewport.center.x * props.viewport.zoom,
      originY = height / 2 + props.viewport.center.y * props.viewport.zoom;
    context.strokeStyle = "rgba(255,255,255,0.06)";
    context.lineWidth = 1;
    for (
      let x = ((originX % gridSize) + gridSize) % gridSize;
      x < width;
      x += gridSize
    ) {
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x, height);
      context.stroke();
    }
    for (
      let y = ((originY % gridSize) + gridSize) % gridSize;
      y < height;
      y += gridSize
    ) {
      context.beginPath();
      context.moveTo(0, y);
      context.lineTo(width, y);
      context.stroke();
    }
  }

  function drawPathLine(
    context: CanvasRenderingContext2D,
    points: Array<{ x: number; y: number }>,
    toScreen: (point: Vec2) => Vec2,
    color: string,
    lineWidth: number,
    dashed: boolean,
    visible: (point: Vec2) => boolean = () => true,
  ) {
    if (lineWidth <= 0 || points.length === 0) return;
    context.save();
    context.strokeStyle = color;
    context.lineWidth = lineWidth;
    context.setLineDash(dashed ? [8, 5] : []);
    context.beginPath();
    let drawing = false;
    points.forEach((point) => {
      if (!visible(point)) {
        drawing = false;
        return;
      }
      const screen = toScreen(point);
      if (!drawing) context.moveTo(screen.x, screen.y);
      else context.lineTo(screen.x, screen.y);
      drawing = true;
    });
    context.stroke();
    context.restore();
  }

  function drawGridSlots(
    context: CanvasRenderingContext2D,
    path: NonNullable<ReturnType<typeof buildTrackGeometry>>["path"],
    toScreen: (point: Vec2) => Vec2,
  ) {
    const zoom = camera(
      context.canvas.width / (window.devicePixelRatio || 1),
      context.canvas.height / (window.devicePixelRatio || 1),
    ).zoom;
    generateGrid(props.document, path).forEach((slot) => {
      const screen = toScreen(slot.position);
      const tip = toScreen({
        x: slot.position.x + slot.tangent.x,
        y: slot.position.y + slot.tangent.y,
      });
      context.save();
      context.translate(screen.x, screen.y);
      context.rotate(Math.atan2(tip.y - screen.y, tip.x - screen.x));
      context.strokeStyle = "rgba(255,209,102,.9)";
      context.lineWidth = 1;
      context.strokeRect(-1.5 * zoom, -0.65 * zoom, 3 * zoom, 1.3 * zoom);
      context.restore();
    });
  }

  function drawZones(
    context: CanvasRenderingContext2D,
    geometries: Record<
      string,
      NonNullable<ReturnType<typeof buildTrackGeometry>>
    >,
    toScreen: (point: Vec2) => Vec2,
  ) {
    props.document.zones.forEach((zone) => {
      const path = geometries[zone.pathId];
      if (!path) return;
      const start = path.path.wrapDistance(zone.startMeters);
      const end = path.path.wrapDistance(zone.endMeters);
      const ranges =
        start <= end
          ? [[start, end]]
          : [
              [start, path.path.totalLengthMeters],
              [0, end],
            ];
      for (const [from, to] of ranges) {
        const points = [
          path.path.positionAtDistance(from),
          ...path.path.samples
            .filter((sample) => sample.s > from && sample.s < to)
            .map((sample) => sample.position),
          to === path.path.totalLengthMeters
            ? path.path.samples.at(-1)!.position
            : path.path.positionAtDistance(to),
        ];
        drawPathLine(
          context,
          points,
          toScreen,
          zone.type.startsWith("drs") ? "#70d7ff" : "#ffcc66",
          5,
          true,
        );
      }
    });
  }

  function drawPitBoxes(
    context: CanvasRenderingContext2D,
    path: NonNullable<ReturnType<typeof buildTrackGeometry>>["path"],
    toScreen: (point: Vec2) => Vec2,
    pathId: string,
  ) {
    props.document.pitBoxes
      .filter((box) => box.pathId === pathId)
      .forEach((box) => {
        const sample = path.sampleAtDistance(box.distanceMeters);
        const normal = { x: -sample.tangent.y, y: sample.tangent.x };
        const screen = toScreen({
          x: sample.position.x + normal.x * box.lateralOffsetMeters,
          y: sample.position.y + normal.y * box.lateralOffsetMeters,
        });
        context.fillStyle = "#ffbd61";
        context.fillRect(screen.x - 5, screen.y - 3, 10, 6);
      });
  }

  function drawMarkers(
    context: CanvasRenderingContext2D,
    primary: ReturnType<typeof buildTrackGeometry>,
    toScreen: (point: Vec2) => Vec2,
  ) {
    props.document.markers.forEach((marker) => {
      const geometry = allPaths[marker.location.pathId];
      if (!geometry) return;
      const sample = geometry.path.sampleAtDistance(
        marker.location.distanceMeters,
      );
      const position = toScreen(sample.position);
      if (marker.type === "start-finish") {
        const tangent = { x: sample.tangent.x, y: sample.tangent.y },
          mag = Math.hypot(tangent.x, tangent.y) || 1;
        drawPathLine(
          context,
          [-1, 1].map((sign) => ({
            x:
              sample.position.x -
              (((tangent.y / mag) * sample.width) / 2) * sign,
            y:
              sample.position.y +
              (((tangent.x / mag) * sample.width) / 2) * sign,
          })),
          toScreen,
          "#fff",
          4,
          true,
        );
      }
      context.fillStyle =
        marker.type === "start-finish"
          ? "#f7f7f2"
          : marker.type.includes("pit")
            ? "#ffbd61"
            : "#ff7b9c";
      context.beginPath();
      context.arc(
        position.x,
        position.y,
        marker.type === "start-finish" ? 7 : 5,
        0,
        Math.PI * 2,
      );
      context.fill();
    });
  }

  function drawProps(
    context: CanvasRenderingContext2D,
    toScreen: (point: Vec2) => Vec2,
    color: string,
  ) {
    props.document.props.forEach((source) => {
      const prop = resolvedFacility(props.document, source);
      const point = toScreen(prop.position);
      context.save();
      context.translate(point.x, point.y);
      context.rotate(
        -prop.rotation +
          (props.spectatorPreview ? props.document.spectatorFrame.rotation : 0),
      );
      context.scale(prop.scale, prop.scale);
      context.fillStyle = prop.id === props.selectedPropId ? "#fff1a8" : color;
      if (prop.type === "tree") {
        context.beginPath();
        context.arc(0, 0, 5, 0, Math.PI * 2);
        context.fill();
      } else if (prop.properties.facility === "pit-garage") {
        const unit = toScreen({ x: prop.position.x + 1, y: prop.position.y }),
          zoom = Math.hypot(unit.x - point.x, unit.y - point.y);
        const width = Math.max(1, zoom * 6),
          depth = Math.max(1, zoom * 8);
        context.fillStyle = "#587385";
        context.fillRect(-width / 2, -depth / 2, width, depth);
        context.strokeStyle = "#bfd5de";
        context.lineWidth = 1;
        context.strokeRect(-width / 2, -depth / 2, width, depth);
        context.fillStyle = "#d4dde1";
        context.fillRect(-width * 0.35, depth / 2 - 3, width * 0.7, 3);
      } else if (prop.type === "barrier") context.fillRect(-8, -2, 16, 4);
      else context.fillRect(-4, -4, 8, 8);
      context.restore();
    });
  }

  function drawControlPoints(
    context: CanvasRenderingContext2D,
    toScreen: (point: Vec2) => Vec2,
  ) {
    const path = activeEditablePath(
      props.document,
      props.tool,
      props.selectedModuleId,
    );
    if (!path?.controlPoints) return;
    path.controlPoints.forEach((point) => {
      const screen = toScreen(point.position);
      const out = toScreen({
        x: point.position.x + point.outHandle.x,
        y: point.position.y + point.outHandle.y,
      });
      const incoming = toScreen({
        x: point.position.x + point.inHandle.x,
        y: point.position.y + point.inHandle.y,
      });
      context.strokeStyle = "rgba(255,209,102,.7)";
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(screen.x, screen.y);
      context.lineTo(out.x, out.y);
      context.moveTo(screen.x, screen.y);
      context.lineTo(incoming.x, incoming.y);
      context.stroke();
      context.fillStyle = "#ffcc66";
      context.fillRect(out.x - 3, out.y - 3, 6, 6);
      context.fillRect(incoming.x - 3, incoming.y - 3, 6, 6);
      context.fillStyle =
        point.id === props.selectedPathPointId ? "#fff1a8" : "#ffcc66";
      context.beginPath();
      context.arc(screen.x, screen.y, 5, 0, Math.PI * 2);
      context.fill();
    });
  }

  function drawOpenConnectors(
    context: CanvasRenderingContext2D,
    toScreen: (point: Vec2) => Vec2,
  ) {
    getOpenConnectors(props.document).forEach(({ module, connector }) => {
      const screen = toScreen(connector.position);
      context.fillStyle = "#ffcc66";
      context.strokeStyle = "#101820";
      context.lineWidth = 2;
      context.beginPath();
      context.arc(screen.x, screen.y, 5, 0, Math.PI * 2);
      context.fill();
      context.stroke();
      if (module.id === props.selectedModuleId) {
        context.font = "10px monospace";
        context.fillStyle = "#ffe5a0";
        context.fillText(connector.id, screen.x + 8, screen.y - 8);
      }
    });
  }

  function drawModules(
    context: CanvasRenderingContext2D,
    toScreen: (point: Vec2) => Vec2,
  ) {
    props.document.modules.forEach((module) => {
      const bounds = getModuleWorldBounds(module);
      const center = toScreen({
        x: (bounds.min.x + bounds.max.x) / 2,
        y: (bounds.min.y + bounds.max.y) / 2,
      });
      const selected = module.id === props.selectedModuleId;
      context.strokeStyle = selected ? "#70d7ff" : "rgba(255,255,255,.12)";
      context.lineWidth = selected ? 2 : 1;
      context.strokeRect(
        center.x -
          Math.max(
            12,
            ((bounds.max.x - bounds.min.x) * props.viewport.zoom) / 2,
          ),
        center.y -
          Math.max(
            12,
            ((bounds.max.y - bounds.min.y) * props.viewport.zoom) / 2,
          ),
        Math.max(24, (bounds.max.x - bounds.min.x) * props.viewport.zoom),
        Math.max(24, (bounds.max.y - bounds.min.y) * props.viewport.zoom),
      );
    });
  }

  function drawPlacementPreview(
    context: CanvasRenderingContext2D,
    toScreen: (point: Vec2) => Vec2,
  ) {
    if (!props.placementModule) return;
    const paths = buildModulePaths(props.placementModule);
    const color =
      props.placementStatus === "invalid"
        ? "#ff7b9c"
        : props.placementStatus === "snap"
          ? "#7fe3ad"
          : "#ffd166";
    context.save();
    context.globalAlpha = 0.5;
    context.fillStyle = color;
    for (const path of paths)
      context.fill(
        path2D(
          path.leftBoundary.concat([...path.rightBoundary].reverse()),
          toScreen,
        ),
      );
    context.globalAlpha = 1;
    context.strokeStyle = color;
    context.lineWidth = 2;
    for (const path of paths)
      context.stroke(
        path2D(
          path.leftBoundary.concat([...path.rightBoundary].reverse()),
          toScreen,
        ),
      );
    context.restore();
  }

  function drawSpectatorFrame(
    context: CanvasRenderingContext2D,
    toScreen: (point: Vec2) => Vec2,
  ) {
    const frame = props.document.spectatorFrame;
    const corners = (
      left: number,
      right: number,
      bottom: number,
      top: number,
    ) =>
      [
        { x: left, y: bottom },
        { x: right, y: bottom },
        { x: right, y: top },
        { x: left, y: top },
      ].map((point) => {
        const r = rotate(point, frame.rotation);
        return { x: r.x + frame.center.x, y: r.y + frame.center.y };
      });
    context.save();
    context.strokeStyle = "#ffcc66";
    context.setLineDash([8, 6]);
    context.lineWidth = 2;
    context.stroke(
      path2D(
        corners(
          -frame.size.x / 2,
          frame.size.x / 2,
          -frame.size.y / 2,
          frame.size.y / 2,
        ),
        toScreen,
      ),
    );
    context.globalAlpha = 0.4;
    context.setLineDash([3, 4]);
    context.stroke(
      path2D(
        corners(
          -frame.size.x / 2 + frame.margins.left,
          frame.size.x / 2 - frame.margins.right,
          -frame.size.y / 2 + frame.margins.bottom,
          frame.size.y / 2 - frame.margins.top,
        ),
        toScreen,
      ),
    );
    context.restore();
  }

  function screenToWorld(event: React.PointerEvent<HTMLCanvasElement>): Vec2 {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x:
        (event.clientX - rect.left - rect.width / 2) / props.viewport.zoom +
        props.viewport.center.x,
      y:
        (rect.height / 2 - (event.clientY - rect.top)) / props.viewport.zoom +
        props.viewport.center.y,
    };
  }

  function hitPathPoint(
    point: Vec2,
  ):
    | { pathId: string; pointId: string; handle?: "inHandle" | "outHandle" }
    | undefined {
    const path = activeEditablePath(
      props.document,
      props.tool,
      props.selectedModuleId,
    );
    for (const control of path?.controlPoints ?? []) {
      for (const handle of ["inHandle", "outHandle"] as const) {
        if (
          Math.hypot(control[handle].x, control[handle].y) > 0.01 &&
          Math.hypot(
            control.position.x + control[handle].x - point.x,
            control.position.y + control[handle].y - point.y,
          ) <=
            7 / props.viewport.zoom
        )
          return { pathId: path!.id, pointId: control.id, handle };
      }
      if (
        Math.hypot(
          control.position.x - point.x,
          control.position.y - point.y,
        ) <=
        7 / props.viewport.zoom
      )
        return { pathId: path!.id, pointId: control.id };
    }
  }

  function hitProp(point: Vec2): string | undefined {
    return [...props.document.props]
      .reverse()
      .find(
        (prop) =>
          Math.hypot(prop.position.x - point.x, prop.position.y - point.y) <=
          8 / props.viewport.zoom,
      )?.id;
  }

  function onPointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    const point = screenToWorld(event);
    if (props.spectatorPreview) return;
    if (event.button === 1 || spaceRef.current || event.shiftKey) {
      dragRef.current = {
        kind: "pan",
        pan: props.viewport.center,
        screen: { x: event.clientX, y: event.clientY },
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    if (event.button !== 0 || props.tool === "test") return;
    if (props.tool === "terrain") {
      dragRef.current = { kind: "terrain" };
      props.onTerrainStroke(point);
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    if (props.placingDefinitionId) {
      props.onPlaceModule(point);
      return;
    }
    if (props.tool === "markers") {
      props.onAddMarker(point);
      return;
    }
    const moduleControl = props.selectedModuleId
      ? hitPathPoint(point)
      : undefined;
    if (moduleControl?.pathId.startsWith("module:")) {
      props.onSelectPathPoint(moduleControl.pathId, moduleControl.pointId);
      dragRef.current = { kind: "path", ...moduleControl };
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    if (
      props.tool === "racing-line" ||
      (props.tool === "pit" &&
        activeEditablePath(props.document, "pit")?.controlPoints?.length)
    ) {
      const hit = hitPathPoint(point);
      if (hit) {
        props.onSelectPathPoint(hit.pathId, hit.pointId);
        dragRef.current = { kind: "path", ...hit };
        event.currentTarget.setPointerCapture(event.pointerId);
      } else if (props.tool === "racing-line")
        props.onAddPathPoint(point, "racing-line");
      return;
    }
    if (props.tool === "zones") {
      props.onAddZone(point);
      return;
    }
    if (props.tool === "props") {
      const propId = hitProp(point);
      if (propId) {
        props.onSelectProp(propId);
        dragRef.current = { kind: "prop", propId };
        event.currentTarget.setPointerCapture(event.pointerId);
      } else props.onAddProp(point);
      return;
    }
    if (props.tool === "spectator") {
      props.onSetSpectatorCenter(point);
      return;
    }
    const hit = [...props.document.modules]
      .filter(
        (module) =>
          props.tool !== "pit" ||
          props.document.paths.some(
            (path) =>
              path.kind === "pit" && path.sourceModuleIds.includes(module.id),
          ),
      )
      .reverse()
      .find((module) => moduleContainsPoint(module, point));
    props.onSelectModule(hit?.id);
    if (hit) {
      dragRef.current = {
        kind: "module",
        moduleId: hit.id,
        offset: {
          x: hit.transform.position.x - point.x,
          y: hit.transform.position.y - point.y,
        },
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    }
  }

  function onPointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    if (drag.kind === "pan") {
      const dx = (event.clientX - drag.screen.x) / props.viewport.zoom;
      const dy = (event.clientY - drag.screen.y) / props.viewport.zoom;
      props.onViewportChange({
        ...props.viewport,
        center: { x: drag.pan.x - dx, y: drag.pan.y + dy },
      });
      return;
    }
    const point = screenToWorld(event);
    if (drag.kind === "module")
      props.onMoveModule(drag.moduleId, {
        x: point.x + drag.offset.x,
        y: point.y + drag.offset.y,
      });
    else if (drag.kind === "path") {
      if (drag.handle)
        props.onMovePathHandle?.(drag.pathId, drag.pointId, drag.handle, point);
      else props.onMovePathPoint(drag.pathId, drag.pointId, point);
    } else if (drag.kind === "prop") props.onMoveProp(drag.propId, point);
    else if (drag.kind === "terrain") props.onTerrainStroke(point);
  }

  function onPointerUp(event: React.PointerEvent<HTMLCanvasElement>) {
    if (dragRef.current && dragRef.current.kind !== "pan") props.onCommitMove();
    dragRef.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function onWheel(event: React.WheelEvent<HTMLCanvasElement>) {
    if (props.spectatorPreview) return;
    const rect = event.currentTarget.getBoundingClientRect(),
      x = event.clientX - rect.left - rect.width / 2,
      y = rect.height / 2 - (event.clientY - rect.top);
    const zoom = Math.max(
      0.05,
      Math.min(15, props.viewport.zoom * (event.deltaY > 0 ? 0.9 : 1.1)),
    );
    props.onViewportChange({
      zoom,
      center: {
        x: props.viewport.center.x + x / props.viewport.zoom - x / zoom,
        y: props.viewport.center.y + y / props.viewport.zoom - y / zoom,
      },
    });
  }

  return (
    <div className="viewport" ref={rootRef}>
      <canvas
        aria-label="Track editing canvas"
        aria-description={
          props.placingDefinitionId
            ? "Placement: " + props.placementStatus
            : "Drag to move. Space and drag to pan. Scroll to zoom."
        }
        tabIndex={0}
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={(event) => {
          if (props.placingDefinitionId && !dragRef.current)
            props.onPlacementPreview(screenToWorld(event));
          onPointerMove(event);
        }}
        onPointerLeave={() => {
          if (props.placingDefinitionId) props.onPlacementPreview(undefined);
        }}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          props.onCancelMove();
          dragRef.current = undefined;
        }}
        onWheel={onWheel}
      />
    </div>
  );
}

function adjustColor(hex: string, amount: number): string {
  const value = hex.replace("#", "");
  const number = Number.parseInt(value, 16);
  const r = Math.max(0, Math.min(255, (number >> 16) + amount));
  const g = Math.max(0, Math.min(255, ((number >> 8) & 255) + amount));
  const b = Math.max(0, Math.min(255, (number & 255) + amount));
  return `rgb(${r},${g},${b})`;
}
