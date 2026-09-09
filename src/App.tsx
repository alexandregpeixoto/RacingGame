import { useEffect, useMemo, useRef, useState } from "react";
import { CanvasViewport, type ViewportState } from "./editor/CanvasViewport";
import {
  ModulePalette,
  ParameterFields,
  RoutePanel,
  FrameControls,
  CommitNumber,
  PitSectionPanel,
} from "./editor/LibraryPanels";
import {
  CATALOG,
  DEFAULT_CATALOG_SETTINGS,
  placeCatalogEntity,
} from "./domain/track/catalog";
import { defaultFreeform } from "./domain/track/advancedModules";
import { syncPitJunctions } from "./domain/track/routes";
import {
  modulePathId,
  buildAllPathGeometries,
  buildTrackGeometry,
  getModuleWorldBounds,
  getOpenConnectors,
  getWorldConnector,
  snapModuleToOpenConnector,
  connectMatchingConnectors,
  connectorsCompatible,
  modulesOverlap,
  effectiveModule,
  reconcileMarkerAnchors,
} from "./domain/track/geometry";
import {
  cloneDocument,
  createControlPoint,
  createEmptyDocument,
  createSampleDocument,
  createTerrain,
  ensureControlPath,
  hydrateDocument,
  id,
  touch,
} from "./domain/track/document";
import {
  getModuleDefinition,
  MODULE_DEFINITIONS,
  createModuleGeometry,
} from "./domain/track/modules";
import { diagnostics, validateDocument } from "./domain/track/validation";
import { THEME_PACKS } from "./domain/track/themes";
import type {
  MarkerType,
  TrackDocument,
  TrackModule,
  TrackProp,
  Vec2,
} from "./domain/track/types";
import {
  downloadDocument,
  loadDocument,
  loadLastDocument,
  listDocuments,
  parseDocument,
  saveDocument,
} from "./persistence";

import {
  fitSpectatorFrame as fitFrame,
  generateGrid,
  spectatorTrackPoints,
} from "./domain/track/authoring";
import {
  createGhost,
  ghostPosition,
  stepGhost,
  GHOST_STEP_SECONDS,
} from "./domain/track/ghost";
import { boundsFromPoints, rotate } from "./domain/track/math";
import {
  trackFollowingTerrain,
  terrainFollowingTrack,
} from "./domain/track/terrain";

import {
  prepareModulePlacement,
  pitPathId,
  rebuildPitWithModules,
  attachPitEndpoints,
} from "./domain/track/pit";

type Tool =
  | "select"
  | "place"
  | "markers"
  | "grid"
  | "spectator"
  | "test"
  | "racing-line"
  | "pit"
  | "zones"
  | "terrain"
  | "elevation"
  | "props";
type HistoryEntry = {
  before: TrackDocument;
  after: TrackDocument;
  label: string;
};

const TOOL_ITEMS: Array<{ id: Tool; label: string; icon: string }> = [
  { id: "select", label: "Select", icon: "⌁" },
  { id: "place", label: "Construct", icon: "+" },
  { id: "racing-line", label: "Racing Line", icon: "⌁" },
  { id: "pit", label: "Pit Path", icon: "∿" },
  { id: "markers", label: "Markers", icon: "⚑" },
  { id: "zones", label: "Zones", icon: "▤" },
  { id: "grid", label: "Grid", icon: "▦" },
  { id: "terrain", label: "Terrain", icon: "▧" },
  { id: "elevation", label: "Elevation", icon: "↕" },
  { id: "props", label: "Props", icon: "✦" },
  { id: "spectator", label: "Spectator", icon: "□" },
  { id: "test", label: "Test", icon: "▶" },
];

export default function App() {
  const [document, setDocument] = useState<TrackDocument>(() =>
    createSampleDocument(),
  );
  const [tool, setTool] = useState<Tool>("select");
  const [placingDefinitionId, setPlacingDefinitionId] =
    useState<TrackModule["definitionId"]>();
  const [placementPreview, setPlacementPreview] = useState<Vec2>();
  const [selectedModuleId, setSelectedModuleId] = useState<string>();
  const [selectedPathPointId, setSelectedPathPointId] = useState<string>();
  const [selectedPropId, setSelectedPropId] = useState<string>();
  const [viewport, setViewport] = useState<ViewportState>({
    center: { x: 0, y: 30 },
    zoom: 4.3,
  });
  const [showCenterline, setShowCenterline] = useState(true);
  const [spectatorVisible, setSpectatorVisible] = useState(true);
  const [report, setReport] = useState(() => validateDocument(document));
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [future, setFuture] = useState<HistoryEntry[]>([]);
  const [testRunning, setTestRunning] = useState(false);
  const [ghost, setGhost] = useState(createGhost);
  const [storageReady, setStorageReady] = useState(false);
  const [savedTracks, setSavedTracks] = useState<
    Array<{ id: string; name: string }> | undefined
  >();
  const [placementParameters, setPlacementParameters] = useState<
    Record<string, number>
  >({});
  const [placementRotation, setPlacementRotation] = useState(0);
  const [placementConnector, setPlacementConnector] = useState("start");
  const [placementTraversal, setPlacementTraversal] = useState("main");
  const [selectedMarkerId, setSelectedMarkerId] = useState<string>();
  const [selectedZoneId, setSelectedZoneId] = useState<string>();
  const [spectatorPreview, setSpectatorPreview] = useState(false);
  const [notice, setNotice] = useState("Ready");
  const [activeRouteId, setActiveRouteId] = useState("primary");
  const [catalogAction, setCatalogAction] = useState<string>();
  const [catalogSettings, setCatalogSettings] = useState(
    DEFAULT_CATALOG_SETTINGS,
  );
  const [penPoints, setPenPoints] = useState<Vec2[]>([]);
  const [markerType, setMarkerType] = useState<MarkerType>("checkpoint");
  const [zoneType, setZoneType] = useState("drs");
  const [zonePathId, setZonePathId] = useState("primary");
  const [propType, setPropType] = useState<TrackProp["type"]>("tree");
  const [terrainBrush, setTerrainBrush] = useState(2);
  const [terrainStrength, setTerrainStrength] = useState(1);
  const [flattenHeight, setFlattenHeight] = useState(0);
  const [terrainMode, setTerrainMode] = useState<
    "raise" | "lower" | "smooth" | "flatten"
  >("raise");
  const transientRef = useRef<TrackDocument | undefined>(undefined);
  const documentRef = useRef(document);
  documentRef.current = document;
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const fileInputRef = useRef<HTMLInputElement>(null);

  const geometry = useMemo(() => buildTrackGeometry(document), [document]);
  const allGeometries = useMemo(
    () => buildAllPathGeometries(document),
    [document],
  );
  const stats = useMemo(() => diagnostics(document), [document]);
  const primaryId =
    document.paths.find((path) => path.kind === "primary-loop")?.id ??
    "primary";
  const testPathId = document.paths.some((p) => p.id === activeRouteId)
    ? activeRouteId
    : primaryId;
  const testGeometry = allGeometries[testPathId];
  const simulationSignature = JSON.stringify([
    document.modules,
    document.connections,
    document.paths,
    document.markers,
    document.zones,
    testPathId,
  ]);
  const startDistance =
    document.markers.find(
      (marker) =>
        marker.type === "start-finish" && marker.location.pathId === testPathId,
    )?.location.distanceMeters ?? 0;
  const ghostInfo = testGeometry
    ? ghostPosition(ghost, testGeometry.path, startDistance)
    : { distance: 0, elapsed: 0, progress: 0, lap: 0 };
  const testDistance = ghostInfo.distance,
    testElapsed = ghostInfo.elapsed;
  useEffect(() => {
    if (testGeometry && !testGeometry.path.closed && ghostInfo.progress >= 1)
      setTestRunning(false);
  }, [ghostInfo.progress, testGeometry]);
  const selectedMarker = document.markers.find(
    (marker) => marker.id === selectedMarkerId,
  );
  const selectedZone = document.zones.find(
    (zone) => zone.id === selectedZoneId,
  );
  const selectedModule = document.modules.find(
    (module) => module.id === selectedModuleId,
  );
  const selectedPath = document.paths.find((path) =>
    path.controlPoints?.some((point) => point.id === selectedPathPointId),
  );
  const selectedPoint = selectedPath?.controlPoints?.find(
    (point) => point.id === selectedPathPointId,
  );
  const selectedProp = document.props.find(
    (prop) => prop.id === selectedPropId,
  );
  const pitId = pitPathId(document);
  const pitPath = document.paths.find((path) => path.id === pitId);
  const legacyPit = Boolean(pitPath?.controlPoints?.length);
  const constructionPathId =
    tool === "pit"
      ? pitId
      : document.paths.some((p) => p.id === activeRouteId)
        ? activeRouteId
        : primaryId;
  function chooseCatalog(entryId: string) {
    const entry = CATALOG.find((e) => e.id === entryId)!;
    if (entryId === "pit-lane") {
      selectTool("pit");
      setActiveRouteId(pitId);
      return;
    }
    if (
      entryId === "freeform-curve" ||
      entryId === "loop-connector" ||
      !entry.geometry
    ) {
      setActiveRouteId(constructionPathId);
      selectTool("markers");
      setCatalogAction(entryId);
      setPenPoints([]);
      setNotice(
        entryId === "freeform-curve"
          ? "Click points on the canvas, then Finish Freeform"
          : entryId === "loop-connector"
            ? "Click two free connectors to reconnect"
            : "Click the active route to place " + entry.label,
      );
      return;
    }
    const definition = getModuleDefinition(entryId)!;
    const isPit = tool === "pit";
    selectTool(isPit ? "pit" : "place");
    setPlacingDefinitionId(entryId);
    setPlacementRotation(0);
    setPlacementConnector("start");
    setPlacementTraversal("main");
    setPlacementParameters({
      ...definition.defaultParameters,
      ...(isPit ? { width: pitPath?.widthMeters ?? 6 } : {}),
    });
  }
  function finishFreeform() {
    if (penPoints.length < 2) return;
    const origin = penPoints[0],
      points = penPoints.map((p, i) => {
        const previous = penPoints[Math.max(0, i - 1)],
          next = penPoints[Math.min(penPoints.length - 1, i + 1)];
        const handle = {
          x: (next.x - previous.x) / 6,
          y: (next.y - previous.y) / 6,
        };
        return {
          id: id("control"),
          position: { x: p.x - origin.x, y: p.y - origin.y, z: 0 },
          inHandle: { x: -handle.x, y: -handle.y },
          outHandle: handle,
        };
      });
    const module: TrackModule = {
      id: id("module"),
      definitionId: "freeform-curve",
      transform: { position: { ...origin, z: 0 }, rotation: 0 },
      parameters: { width: placementParameters.width ?? 10 },
      controlPoints: points,
    };
    const result = prepareModulePlacement(
      document,
      module,
      constructionPathId,
      0.05,
    );
    if (result.status === "invalid") {
      setNotice(
        "Freeform overlaps another road; adjust or cancel the pen draft.",
      );
      return;
    }
    commit(result.document, "Create freeform road");
    setPenPoints([]);
    selectTool("select");
    setSelectedModuleId(module.id);
  }
  function catalogPoint(point: Vec2) {
    if (catalogAction === "freeform-curve") {
      setPenPoints((points) => [...points, point]);
      return;
    }
    if (catalogAction === "loop-connector") {
      const open = getOpenConnectors(document),
        closest = open.sort(
          (a, b) =>
            Math.hypot(
              a.connector.position.x - point.x,
              a.connector.position.y - point.y,
            ) -
            Math.hypot(
              b.connector.position.x - point.x,
              b.connector.position.y - point.y,
            ),
        )[0];
      if (
        !closest ||
        Math.hypot(
          closest.connector.position.x - point.x,
          closest.connector.position.y - point.y,
        ) >
          15 / viewport.zoom
      ) {
        setNotice("Click an open connector");
        return;
      }
      if (!penPoints.length) {
        setPenPoints([closest.connector.position]);
        return;
      }
      const first = open.find(
        (p) =>
          Math.hypot(
            p.connector.position.x - penPoints[0].x,
            p.connector.position.y - penPoints[0].y,
          ) < 0.001,
      );
      if (
        !first ||
        first === closest ||
        Math.abs(first.connector.width - closest.connector.width) > 0.01
      ) {
        setNotice("Choose two distinct equal-width connectors");
        return;
      }
      const a = first.connector,
        b = closest.connector,
        length =
          Math.hypot(b.position.x - a.position.x, b.position.y - a.position.y) /
          3;
      const controls = defaultFreeform();
      controls[0].outHandle = {
        x: Math.cos(a.tangent) * length,
        y: Math.sin(a.tangent) * length,
      };
      controls[1].position = {
        x: b.position.x - a.position.x,
        y: b.position.y - a.position.y,
        z: b.position.z - a.position.z,
      };
      controls[1].inHandle = {
        x: Math.cos(b.tangent) * length,
        y: Math.sin(b.tangent) * length,
      };
      const module: TrackModule = {
        id: id("module"),
        definitionId: "loop-connector",
        transform: { position: a.position, rotation: 0 },
        parameters: { width: a.width },
        controlPoints: controls,
      };
      const result = prepareModulePlacement(
        document,
        module,
        constructionPathId,
        0.05,
      );
      if (result.status === "invalid") {
        setNotice("Connector geometry overlaps another road");
        return;
      }
      commit(
        connectMatchingConnectors(result.document),
        "Reconnect route with loop connector",
      );
      setPenPoints([]);
      selectTool("select");
      return;
    }
    try {
      const next = placeCatalogEntity(
        document,
        catalogAction!,
        constructionPathId,
        point,
        catalogSettings,
      );
      commit(next, "Place " + catalogAction);
      if (next.zones.length > document.zones.length)
        setCatalogSettings((s) => ({ ...s, zoneId: next.zones.at(-1)!.id }));
    } catch (error) {
      setNotice(String(error));
    }
  }
  function placementAt(point: Vec2, moduleId = "preview") {
    const definition =
      placingDefinitionId && getModuleDefinition(placingDefinitionId);
    if (!definition) return undefined;
    const candidate: TrackModule = {
      id: moduleId,
      definitionId: definition.id,
      transform: { position: { ...point, z: 0 }, rotation: placementRotation },
      parameters: { ...definition.defaultParameters, ...placementParameters },
    };
    if (tool === "pit" && legacyPit) return undefined;
    return prepareModulePlacement(
      document,
      candidate,
      constructionPathId,
      18 / viewport.zoom,
      placementConnector,
      placementTraversal,
    );
  }
  const placement = useMemo(
    () => (placementPreview ? placementAt(placementPreview) : undefined),
    [
      document,
      placementPreview,
      placingDefinitionId,
      placementRotation,
      placementParameters,
      placementConnector,
      placementTraversal,
      constructionPathId,
      viewport.zoom,
    ],
  );
  const placementStatus = placement?.status ?? "ready";

  function queueSave(track: TrackDocument, manual = false) {
    const snapshot = cloneDocument(track);
    saveQueue.current = saveQueue.current
      .catch(() => undefined)
      .then(() => saveDocument(snapshot));
    void saveQueue.current
      .then(() => {
        if (manual) setNotice("Saved locally");
      })
      .catch((error) => setNotice("Save failed: " + String(error)));
    return saveQueue.current;
  }
  useEffect(() => {
    setReport(validateDocument(document));
    if (!storageReady || transientRef.current) return;
    const timeout = window.setTimeout(() => {
      void queueSave(document);
    }, 650);
    return () => window.clearTimeout(timeout);
  }, [document, storageReady]);

  useEffect(() => {
    let active = true;
    void loadLastDocument()
      .then((saved) => {
        if (active && saved) {
          setDocument(saved);
          setNotice("Recovered saved track");
        }
      })
      .catch((error) => {
        if (active)
          setNotice("Could not recover local track: " + String(error));
      })
      .finally(() => {
        if (active) setStorageReady(true);
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    setTestRunning(false);
    setGhost(createGhost());
  }, [simulationSignature]);
  useEffect(() => {
    if (!testRunning || !testGeometry) return;
    let last = performance.now(),
      accumulator = 0,
      animation = 0;
    const tick = (now: number) => {
      accumulator += Math.min(0.25, (now - last) / 1000);
      last = now;
      const ticks = Math.floor(accumulator / GHOST_STEP_SECONDS);
      if (ticks > 0) {
        accumulator -= ticks * GHOST_STEP_SECONDS;
        setGhost((current) =>
          stepGhost(
            current,
            testGeometry.path,
            document.markers,
            testPathId,
            ticks,
            startDistance,
            document.zones,
          ),
        );
      }
      animation = requestAnimationFrame(tick);
    };
    animation = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animation);
  }, [
    testRunning,
    testGeometry,
    report.valid,
    document.markers,
    testPathId,
    startDistance,
  ]);

  function cancelTransient() {
    if (transientRef.current) {
      documentRef.current = transientRef.current;
      setDocument(transientRef.current);
    }
    transientRef.current = undefined;
  }
  function updateDraft(next: TrackDocument) {
    documentRef.current = next;
    setDocument(next);
  }

  function commit(next: TrackDocument, label: string) {
    const before = cloneDocument(document);
    const after = touch(
      syncPitJunctions(reconcileMarkerAnchors(before, cloneDocument(next))),
    );
    setDocument(after);
    setHistory((items) => [...items, { before, after, label }]);
    setFuture([]);
    setNotice(label);
  }

  function selectTool(nextTool: Tool) {
    setCatalogAction(undefined);
    setPenPoints([]);
    cancelTransient();
    setSelectedMarkerId(undefined);
    setSelectedZoneId(undefined);
    setSelectedModuleId(undefined);
    setTool(nextTool);
    if (nextTool === "pit")
      setPlacementParameters({
        length: 20,
        radius: 15,
        width: pitPath?.widthMeters ?? 6,
        elevationDelta: 0,
        angle: Math.PI / 2,
      });
    setPlacingDefinitionId(undefined);
    setPlacementPreview(undefined);
    setSelectedPathPointId(undefined);
    setSelectedPropId(undefined);
    if (nextTool !== "test") setTestRunning(false);
  }

  function addModule(point: Vec2) {
    if (!placingDefinitionId) return;
    const definition = getModuleDefinition(placingDefinitionId);
    if (!definition) return;
    const result = placementAt(point, id("module"));
    if (!result || result.status === "invalid") {
      setNotice("Invalid placement: geometry overlaps an existing module");
      return;
    }
    const routeRole = (
      {
        "shortcut-branch": "shortcut",
        "joker-lap-entry": "joker",
        "service-road-junction": "service",
        "pit-entry": "pit",
      } as Record<string, string>
    )[definition.id];
    if (
      routeRole &&
      !result.document.paths.some(
        (p) =>
          p.sourceModuleIds.includes(result.module.id) &&
          p.id !== constructionPathId,
      )
    ) {
      result.document.paths.push({
        id: id(routeRole),
        kind: routeRole === "pit" ? "pit" : "secondary",
        closed: false,
        widthMeters: result.module.parameters.branchWidth ?? 10,
        sourceModuleIds: [result.module.id],
        traversals: [
          {
            moduleId: result.module.id,
            traversalId: "branch",
            reversed: false,
          },
        ],
        metadata: { role: routeRole },
      });
    }
    commit(
      result.document,
      `Add ${tool === "pit" ? "pit " : ""}${definition.label}`,
    );
    setSelectedModuleId(result.module.id);
    setPlacementPreview(undefined);
    setPlacingDefinitionId(undefined);
    if (tool !== "pit") setTool("select");
  }

  function addMarkerAtPoint(point: Vec2) {
    if (catalogAction) {
      catalogPoint(point);
      return;
    }
    const pathGeometry = allGeometries[primaryId];
    if (!pathGeometry) return;
    if (
      markerType === "start-finish" &&
      document.markers.some((marker) => marker.type === "start-finish")
    ) {
      setNotice("Only one Start/Finish marker is allowed");
      return;
    }
    const projection = pathGeometry.path.nearestPoint(point);
    const next = cloneDocument(document);
    const marker = {
      id: id("marker"),
      type: markerType,
      location: {
        pathId: primaryId,
        distanceMeters: projection.distanceMeters,
        anchor: projection.moduleId
          ? { moduleId: projection.moduleId, localT: projection.localT ?? 0 }
          : undefined,
      },
      configuration: { label: markerType.replaceAll("-", " ") },
    };
    next.markers.push(marker);
    if (markerType === "start-finish") next.grid.startMarkerId = marker.id;
    commit(next, `Add ${markerType.replaceAll("-", " ")}`);
    selectTool(
      markerType === "pit-entry" || markerType === "pit-exit"
        ? "pit"
        : "select",
    );
  }

  function addPathPoint(point: Vec2, pathId: string) {
    const next = cloneDocument(document);
    const path = ensureControlPath(
      next,
      pathId,
      pathId === "pit" ? "pit" : "racing-line",
      pathId === "pit" ? 6 : 1.4,
      pathId !== "pit",
    );
    path.controlPoints?.push(createControlPoint(point));
    commit(next, `Add ${pathId === "pit" ? "pit" : "Racing Line"} point`);
    setSelectedPathPointId(path.controlPoints?.at(-1)?.id);
    setSelectedModuleId(undefined);
  }

  function startTransient() {
    if (!transientRef.current)
      transientRef.current = cloneDocument(documentRef.current);
  }
  function movePathPoint(pathId: string, pointId: string, point: Vec2) {
    if (pathId.startsWith("module:")) {
      moveModuleControl(pathId.slice(7), pointId, point);
      return;
    }
    startTransient();
    const next = cloneDocument(documentRef.current);
    const path = next.paths.find((item) => item.id === pathId);
    const controlPoint = path?.controlPoints?.find(
      (item) => item.id === pointId,
    );
    if (controlPoint)
      controlPoint.position = {
        ...controlPoint.position,
        x: point.x,
        y: point.y,
      };
    updateDraft(next);
  }
  function moveModuleControl(
    moduleId: string,
    pointId: string,
    position: Vec2,
    handle?: "inHandle" | "outHandle",
  ) {
    startTransient();
    const next = cloneDocument(documentRef.current),
      module = next.modules.find((m) => m.id === moduleId)!;
    const point = module.controlPoints?.find((p) => p.id === pointId);
    if (!point) return;
    const local = rotate(
      {
        x: position.x - module.transform.position.x,
        y: position.y - module.transform.position.y,
      },
      -module.transform.rotation,
    );
    if (handle)
      point[handle] = {
        x: local.x - point.position.x,
        y: local.y - point.position.y,
      };
    else point.position = { ...point.position, ...local };
    updateDraft(next);
  }
  function moveModule(moduleId: string, point: Vec2) {
    startTransient();
    const next = cloneDocument(documentRef.current);
    next.connections = next.connections.filter(
      (connection) =>
        connection.a.moduleId !== moduleId &&
        connection.b.moduleId !== moduleId,
    );
    const module = next.modules.find((item) => item.id === moduleId);
    if (module) {
      module.transform.position = { ...module.transform.position, ...point };
      const snapped = snapModuleToOpenConnector(
        next,
        module,
        18 / viewport.zoom,
        modulePathId(next, moduleId),
      );
      Object.assign(module, snapped.module);
      if (snapped.connection)
        next.connections.push({ id: id("connection"), ...snapped.connection });
    }
    updateDraft(connectMatchingConnectors(next));
  }
  function moveProp(propId: string, point: Vec2) {
    startTransient();
    const next = cloneDocument(documentRef.current);
    const prop = next.props.find((item) => item.id === propId);
    if (prop) prop.position = { ...prop.position, x: point.x, y: point.y };
    updateDraft(next);
  }

  function finishTransient() {
    if (!transientRef.current) return;
    const before = transientRef.current;
    const after = touch(
      reconcileMarkerAnchors(before, cloneDocument(documentRef.current)),
    );
    transientRef.current = undefined;
    documentRef.current = after;
    setDocument(after);
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    setHistory((items) => [
      ...items,
      {
        before,
        after,
        label:
          tool === "terrain"
            ? "Sculpt terrain"
            : tool === "racing-line"
              ? "Move path point"
              : tool === "props"
                ? "Move prop"
                : "Move module",
      },
    ]);
    setFuture([]);
    setNotice("Edit committed");
  }

  function sculptTerrain(point: Vec2) {
    startTransient();
    const next = cloneDocument(documentRef.current);
    const terrain = next.terrain ?? createTerrain();
    next.terrain = terrain;
    const cx = Math.floor(
      (point.x - terrain.origin.x) / terrain.cellSizeMeters,
    );
    const cy = Math.floor(
      (point.y - terrain.origin.y) / terrain.cellSizeMeters,
    );
    const sign = terrainMode === "raise" ? 1 : -1;
    const original = [...terrain.elevations];
    for (
      let y = Math.max(0, cy - terrainBrush);
      y <= Math.min(terrain.height - 1, cy + terrainBrush);
      y += 1
    )
      for (
        let x = Math.max(0, cx - terrainBrush);
        x <= Math.min(terrain.width - 1, cx + terrainBrush);
        x += 1
      ) {
        const radius = Math.hypot(x - cx, y - cy);
        if (radius <= terrainBrush) {
          const falloff = 1 - radius / Math.max(1, terrainBrush);
          const index = y * terrain.width + x;
          if (terrainMode === "smooth") {
            const neighbors: number[] = [];
            for (let oy = -1; oy <= 1; oy += 1)
              for (let ox = -1; ox <= 1; ox += 1) {
                const nx = x + ox;
                const ny = y + oy;
                if (
                  nx >= 0 &&
                  ny >= 0 &&
                  nx < terrain.width &&
                  ny < terrain.height
                )
                  neighbors.push(original[ny * terrain.width + nx]);
              }
            terrain.elevations[index] =
              original[index] +
              (neighbors.reduce((sum, value) => sum + value, 0) /
                Math.max(1, neighbors.length) -
                original[index]) *
                Math.min(1, terrainStrength * falloff);
          } else if (terrainMode === "flatten")
            terrain.elevations[index] =
              original[index] +
              (flattenHeight - original[index]) *
                Math.min(1, terrainStrength * falloff);
          else terrain.elevations[index] += sign * terrainStrength * falloff;
        }
      }
    updateDraft(next);
  }

  function addPitBox() {
    const pitGeometry = allGeometries[pitId];
    if (!pitGeometry) {
      setNotice("Create a Pit Path before adding pit boxes");
      return;
    }
    const next = cloneDocument(document);
    const order = next.pitBoxes.length + 1;
    next.pitBoxes.push({
      id: id("pit-box"),
      pathId: pitId,
      distanceMeters: Math.max(
        0,
        Math.min(pitGeometry.path.totalLengthMeters - 2, 4 + (order - 1) * 8),
      ),
      lateralOffsetMeters: 0,
      order,
      speedLimitKph: 60,
    });
    commit(next, "Add pit box");
  }

  function trackFollowsTerrain() {
    commit(trackFollowingTerrain(document), "Track follows terrain");
  }
  function terrainFollowsTrack() {
    if (geometry)
      commit(terrainFollowingTrack(document), "Terrain follows track");
  }

  function addZone(point: Vec2) {
    const pathGeometry = allGeometries[zonePathId];
    if (!pathGeometry) {
      setNotice("Create the selected path before adding a zone");
      return;
    }
    const projection = pathGeometry.path.nearestPoint(point);
    const next = cloneDocument(document);
    next.zones.push({
      id: id("zone"),
      type: zoneType,
      pathId: zonePathId,
      startMeters: projection.distanceMeters,
      endMeters: projection.distanceMeters + 30,
      properties: { label: zoneType.toUpperCase() },
    });
    commit(next, `Add ${zoneType} zone`);
    selectTool("select");
  }

  function addProp(point: Vec2) {
    const next = cloneDocument(document);
    const prop: TrackProp = {
      id: id("prop"),
      type: propType,
      position: { ...point, z: 0 },
      rotation: 0,
      scale: 1,
      properties: {},
    };
    next.props.push(prop);
    commit(next, `Add ${propType}`);
    setSelectedPropId(prop.id);
    setSelectedModuleId(undefined);
  }

  function setSpectatorCenter(point: Vec2) {
    const next = cloneDocument(document);
    next.spectatorFrame.center = point;
    commit(next, "Move spectator frame");
  }

  function undo() {
    if (transientRef.current) {
      cancelTransient();
      return;
    }
    const entry = history.at(-1);
    if (!entry) return;
    setDocument(cloneDocument(entry.before));
    setHistory((items) => items.slice(0, -1));
    setFuture((items) => [...items, entry]);
    setNotice(`Undo: ${entry.label}`);
  }
  function redo() {
    const entry = future.at(-1);
    if (!entry) return;
    setDocument(cloneDocument(entry.after));
    setFuture((items) => items.slice(0, -1));
    setHistory((items) => [...items, entry]);
    setNotice(`Redo: ${entry.label}`);
  }

  function deleteSelected() {
    if (selectedMarkerId) {
      const next = cloneDocument(document);
      next.markers = next.markers.filter(
        (item) => item.id !== selectedMarkerId,
      );
      commit(next, "Delete marker");
      setSelectedMarkerId(undefined);
      return;
    }
    if (selectedZoneId) {
      const next = cloneDocument(document);
      next.zones = next.zones.filter((item) => item.id !== selectedZoneId);
      commit(next, "Delete zone");
      setSelectedZoneId(undefined);
      return;
    }
    if (selectedModuleId) {
      const next = cloneDocument(document);
      next.modules = next.modules.filter(
        (module) => module.id !== selectedModuleId,
      );
      next.connections = next.connections.filter(
        (connection) =>
          connection.a.moduleId !== selectedModuleId &&
          connection.b.moduleId !== selectedModuleId,
      );
      next.paths.forEach((path) => {
        if (path.traversals)
          path.traversals = path.traversals.filter(
            (step) => step.moduleId !== selectedModuleId,
          );
        path.sourceModuleIds = path.sourceModuleIds.filter(
          (moduleId) => moduleId !== selectedModuleId,
        );
      });
      commit(next, "Delete module");
      setSelectedModuleId(undefined);
      return;
    }
    if (selectedPath && selectedPathPointId) {
      const next = cloneDocument(document);
      const path = next.paths.find((item) => item.id === selectedPath.id);
      if (path?.controlPoints)
        path.controlPoints = path.controlPoints.filter(
          (point) => point.id !== selectedPathPointId,
        );
      commit(next, "Delete path point");
      setSelectedPathPointId(undefined);
      return;
    }
    if (selectedPropId) {
      const next = cloneDocument(document);
      next.props = next.props.filter((prop) => prop.id !== selectedPropId);
      commit(next, "Delete prop");
      setSelectedPropId(undefined);
    }
  }

  function duplicateSelected() {
    if (!selectedModule) return;
    const next = cloneDocument(document),
      copy = cloneDocument(document).modules.find(
        (module) => module.id === selectedModule.id,
      )!;
    copy.id = id("module");
    copy.transform.position.x += 15;
    copy.transform.position.y += 15;
    next.modules.push(copy);
    next.paths
      .find((path) => path.sourceModuleIds.includes(selectedModule.id))!
      .sourceModuleIds.push(copy.id);
    commit(next, "Duplicate module");
    setSelectedModuleId(copy.id);
  }
  function rotateSelected() {
    if (placingDefinitionId) {
      setPlacementRotation((value) => value + Math.PI / 2);
      return;
    }
    if (!selectedModule) return;
    const next = cloneDocument(document);
    const module = next.modules.find((item) => item.id === selectedModule.id);
    if (module) module.transform.rotation += Math.PI / 2;
    commit(next, "Rotate module");
  }
  function fitTrack() {
    const bounds = boundsFromPoints(
      document.modules.flatMap((module) => {
        const bounds = getModuleWorldBounds(module);
        return [bounds.min, bounds.max];
      }),
    );
    const rect = window.document
      .querySelector("canvas")
      ?.getBoundingClientRect();
    setViewport({
      center: {
        x: (bounds.min.x + bounds.max.x) / 2,
        y: (bounds.min.y + bounds.max.y) / 2,
      },
      zoom: Math.max(
        0.05,
        Math.min(
          8,
          ((rect?.width ?? 800) - 100) /
            Math.max(1, bounds.max.x - bounds.min.x),
          ((rect?.height ?? 600) - 120) /
            Math.max(1, bounds.max.y - bounds.min.y),
        ),
      ),
    });
  }
  function fitSpectatorFrame() {
    if (!geometry) return;
    const next = cloneDocument(document);
    next.spectatorFrame = fitFrame(
      next.spectatorFrame,
      spectatorTrackPoints(next),
    );
    commit(next, "Fit spectator frame");
  }
  function openDocument(next: TrackDocument, message: string) {
    cancelTransient();
    setDocument(next);
    documentRef.current = next;
    setHistory([]);
    setFuture([]);
    selectTool("select");
    setGhost(createGhost());
    setTestRunning(false);
    setSavedTracks(undefined);
    setNotice(message);
  }
  async function showSavedTracks() {
    try {
      await queueSave(documentRef.current);
      setSavedTracks(await listDocuments());
    } catch (error) {
      setNotice(String(error));
    }
  }
  async function openSavedTrack(id: string) {
    try {
      const saved = await loadDocument(id);
      if (saved) openDocument(saved, "Opened local track");
    } catch (error) {
      setNotice(String(error));
    }
  }
  function changeTheme(themeId: string) {
    const theme = THEME_PACKS.find((item) => item.id === themeId);
    if (!theme) return;
    const next = cloneDocument(document);
    next.theme = { id: theme.id, name: theme.name };
    commit(next, `Use ${theme.name}`);
  }
  function updateGrid(
    field: "slotCount" | "longitudinalSpacingMeters" | "lateralSpacingMeters",
    value: number,
  ) {
    const next = cloneDocument(document);
    next.grid[field] =
      field === "slotCount"
        ? Math.max(1, Math.min(1000, Math.round(value)))
        : Math.max(field === "lateralSpacingMeters" ? 0 : 0.5, value);
    commit(next, "Edit starting grid");
  }
  function updateGridPattern(value: "none" | "alternating" | "custom") {
    const next = cloneDocument(document);
    next.grid.staggerPattern = value;
    commit(next, "Edit grid pattern");
  }
  function updateSelectedModuleParameter(name: string, value: number) {
    if (!selectedModule || !Number.isFinite(value)) return;
    const next = cloneDocument(document);
    const module = next.modules.find((item) => item.id === selectedModule.id);
    if (module) {
      if (name === "__z") module.transform.position.z = value;
      else if (name === "__x") module.transform.position.x = value;
      else if (name === "__y") module.transform.position.y = value;
      else
        module.parameters[name] = ["length", "width"].includes(name)
          ? Math.max(2, value)
          : name === "radius"
            ? Math.max(3, value)
            : value;
    }
    commit(next, `Edit ${name.replace("__", "position ")}`);
  }
  function updateSelectedModuleProperty(
    name: "surface" | "kerb",
    value: string,
  ) {
    if (!selectedModule) return;
    const next = cloneDocument(document);
    const module = next.modules.find((item) => item.id === selectedModule.id);
    if (module) {
      const properties = { ...module.properties };
      if (value) properties[name] = value as never;
      else delete properties[name];
      module.properties =
        Object.keys(properties).length > 0 ? properties : undefined;
    }
    commit(next, `Edit ${name} override`);
  }
  function updateSelectedPointHandle(
    handle: "inHandle" | "outHandle",
    axis: "x" | "y",
    value: number,
  ) {
    if (!selectedPathPointId || !selectedPath) return;
    const next = cloneDocument(document);
    const point = next.paths
      .find((path) => path.id === selectedPath.id)
      ?.controlPoints?.find((item) => item.id === selectedPathPointId);
    if (point) point[handle][axis] = value;
    commit(next, "Edit Bézier handle");
  }

  async function newTrack() {
    try {
      await queueSave(documentRef.current);
      openDocument(createEmptyDocument(), "New track");
    } catch {
      setNotice(
        "Could not save the current track; export it before creating another.",
      );
    }
  }
  async function importFile(file: File) {
    try {
      const imported = parseDocument(await file.text());
      await queueSave(documentRef.current);
      openDocument(imported, "Imported track");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Import failed");
    }
  }
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        (event.target as HTMLElement)?.closest(
          "input, textarea, select, [contenteditable=true]",
        )
      )
        return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        event.shiftKey ? redo() : undo();
      } else if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "y"
      ) {
        event.preventDefault();
        redo();
      } else if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "d"
      ) {
        event.preventDefault();
        duplicateSelected();
      } else if (event.key.toLowerCase() === "r") rotateSelected();
      else if (event.key === "Delete") deleteSelected();
      else if (event.key.toLowerCase() === "f") fitTrack();
      else if (event.key === "Escape") {
        cancelTransient();
        selectTool("select");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });
  function focusIssue(entityIds: string[], location?: Vec2) {
    const module = document.modules.find((item) => entityIds.includes(item.id));
    if (module) {
      selectTool("select");
      setSelectedModuleId(module.id);
    }
    const point = location ?? module?.transform.position;
    if (point) setViewport((current) => ({ ...current, center: point }));
  }
  if (!storageReady)
    return <div className="empty-state">Opening local workspace…</div>;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">◒</span>
          <div>
            <strong>Track Creator</strong>
            <small>spectator racing foundation</small>
          </div>
        </div>
        <input
          className="track-name"
          value={document.metadata.name}
          onChange={(event) =>
            commit(
              {
                ...document,
                metadata: { ...document.metadata, name: event.target.value },
              },
              "Rename track",
            )
          }
          aria-label="Track name"
        />
        <div className="top-actions">
          <button onClick={newTrack}>New</button>
          <button onClick={() => void queueSave(document, true)}>Save</button>
          <button onClick={() => void showSavedTracks()}>Open</button>
          <button onClick={undo} disabled={!history.length}>
            Undo
          </button>
          <button onClick={redo} disabled={!future.length}>
            Redo
          </button>
          <button
            className="accent"
            onClick={() => setReport(validateDocument(document))}
          >
            Validate
          </button>
          <button
            disabled={!geometry || !report.valid}
            className={testRunning ? "danger" : "accent"}
            onClick={() => {
              selectTool("test");
              setTestRunning(!testRunning);
            }}
          >
            {testRunning ? "Pause Test" : "Test"}
          </button>
          <button onClick={() => downloadDocument(document)}>Export</button>
          <button onClick={() => fileInputRef.current?.click()}>Import</button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json,.track.json"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void importFile(file);
              event.target.value = "";
            }}
          />
        </div>
      </header>
      <div className="workspace">
        <aside className="left-panel">
          <div className="panel-title">TOOLS</div>
          <div className="tool-grid">
            {TOOL_ITEMS.map((item) => (
              <button
                key={item.id}
                className={`tool-button ${tool === item.id ? "active" : ""}`}
                onClick={() => selectTool(item.id)}
              >
                <span>{item.icon}</span>
                {item.label}
              </button>
            ))}
          </div>
          <div className="panel-divider" />
          <div className="panel-title">
            {tool === "pit" ? "PIT MODULES" : "TRACK MODULES"}
          </div>
          <RoutePanel
            document={document}
            active={constructionPathId}
            selectedModuleId={selectedModuleId}
            select={(value) => {
              setActiveRouteId(value);
              if (tool === "pit") setTool("place");
            }}
            change={commit}
          />
          <ModulePalette
            disabled={tool === "pit" && legacyPit}
            selected={catalogAction ?? placingDefinitionId}
            choose={chooseCatalog}
          />
          <PitSectionPanel
            document={document}
            change={commit}
            error={setNotice}
          />
          {catalogAction && (
            <section className="tool-options">
              <strong>
                {CATALOG.find((e) => e.id === catalogAction)?.label}
              </strong>
              {catalogAction === "pit-speed-line" && (
                <label>
                  Trigger role
                  <select
                    aria-label="Trigger role"
                    value={catalogSettings.lineRole ?? "start"}
                    onChange={(e) =>
                      setCatalogSettings((s) => ({
                        ...s,
                        lineRole: e.target.value as "start" | "end",
                      }))
                    }
                  >
                    <option value="start">Speed limit start</option>
                    <option value="end">Speed limit end</option>
                  </select>
                </label>
              )}
              {catalogAction === "freeform-curve" ? (
                <>
                  <p>{penPoints.length} pen points</p>
                  <button
                    disabled={penPoints.length < 2}
                    onClick={finishFreeform}
                  >
                    Finish Freeform
                  </button>
                  <button onClick={() => setPenPoints((p) => p.slice(0, -1))}>
                    Remove last point
                  </button>
                </>
              ) : (
                catalogAction !== "loop-connector" && (
                  <>
                    <CommitNumber
                      label="Section count"
                      value={catalogSettings.count}
                      min={1}
                      onChange={(count) =>
                        setCatalogSettings((s) => ({
                          ...s,
                          count: Math.min(100, Math.floor(count)),
                        }))
                      }
                    />
                    <CommitNumber
                      label="Section spacing (m)"
                      value={catalogSettings.spacing}
                      min={0.5}
                      onChange={(spacing) =>
                        setCatalogSettings((s) => ({ ...s, spacing }))
                      }
                    />
                    <CommitNumber
                      label="Lateral offset (m)"
                      value={catalogSettings.offset}
                      onChange={(offset) =>
                        setCatalogSettings((s) => ({ ...s, offset }))
                      }
                    />
                    <CommitNumber
                      label="Speed limit (km/h)"
                      value={catalogSettings.speedKph}
                      min={1}
                      onChange={(speedKph) =>
                        setCatalogSettings((s) => ({ ...s, speedKph }))
                      }
                    />
                    <label>
                      Linked zone
                      <select
                        aria-label="Linked zone"
                        value={catalogSettings.zoneId ?? ""}
                        onChange={(e) =>
                          setCatalogSettings((s) => ({
                            ...s,
                            zoneId: e.target.value,
                          }))
                        }
                      >
                        <option value="">Choose zone</option>
                        {document.zones
                          .filter((z) => z.pathId === constructionPathId)
                          .map((z) => (
                            <option key={z.id} value={z.id}>
                              {z.type} · {z.id}
                            </option>
                          ))}
                      </select>
                    </label>
                  </>
                )
              )}
              <button onClick={() => selectTool("select")}>Cancel tool</button>
            </section>
          )}
          <div className="tool-options">
            {(tool === "place" || tool === "pit") && placingDefinitionId && (
              <>
                <label>
                  Snap connector
                  <select
                    aria-label="Snap connector"
                    value={placementConnector}
                    onChange={(e) => {
                      setPlacementConnector(e.target.value);
                      const candidates = createModuleGeometry(
                        placingDefinitionId,
                        placementParameters,
                      )?.traversals?.filter(
                        (t) =>
                          t.entry === e.target.value ||
                          t.exit === e.target.value,
                      );
                      setPlacementTraversal(candidates?.[0]?.id ?? "main");
                    }}
                  >
                    {createModuleGeometry(
                      placingDefinitionId,
                      placementParameters,
                    )?.connectors.map((c) => (
                      <option key={c.id}>{c.id}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Route through piece
                  <select
                    aria-label="Placement traversal"
                    value={placementTraversal}
                    onChange={(e) => setPlacementTraversal(e.target.value)}
                  >
                    {createModuleGeometry(
                      placingDefinitionId,
                      placementParameters,
                    )
                      ?.traversals?.filter(
                        (t) =>
                          t.entry === placementConnector ||
                          t.exit === placementConnector,
                      )
                      .map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.id}: {t.entry} → {t.exit}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  Module preset
                  <select
                    aria-label="Module preset"
                    defaultValue=""
                    onChange={(event) =>
                      setPlacementParameters((current) => ({
                        ...current,
                        [placingDefinitionId === "straight"
                          ? "length"
                          : "radius"]: Number(event.target.value),
                      }))
                    }
                  >
                    <option value="" disabled>
                      Choose preset
                    </option>
                    {(placingDefinitionId === "straight"
                      ? [20, 40, 80]
                      : [15, 30, 60]
                    ).map((value, i) => (
                      <option key={value} value={value}>
                        {
                          (placingDefinitionId === "straight"
                            ? ["Short", "Medium", "Long"]
                            : ["Tight", "Medium", "Gentle"])[i]
                        }{" "}
                        · {value} m
                      </option>
                    ))}
                  </select>
                </label>
                {(placingDefinitionId === "straight"
                  ? ["length", "width"]
                  : Object.keys(
                      getModuleDefinition(placingDefinitionId)!
                        .defaultParameters,
                    ).filter((k) => k !== "elevationDelta")
                ).map((field) => (
                  <label key={field}>
                    Placement {field}
                    <input
                      type="number"
                      step="0.1"
                      value={placementParameters[field] ?? 10}
                      onChange={(event) =>
                        setPlacementParameters((current) => ({
                          ...current,
                          [field]: Number(event.target.value),
                        }))
                      }
                    />
                  </label>
                ))}
                <button className="wide-button" onClick={rotateSelected}>
                  Rotate preview (R)
                </button>
              </>
            )}
            {tool === "markers" && (
              <label>
                Marker type
                <select
                  value={markerType}
                  onChange={(event) =>
                    setMarkerType(event.target.value as MarkerType)
                  }
                >
                  {[
                    "checkpoint",
                    "sector",
                    "timing-line",
                    "speed-trap",
                    "start-finish",
                    "pit-entry",
                    "pit-exit",
                  ].map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>
            )}
            {tool === "zones" && (
              <>
                <label>
                  Zone type
                  <select
                    value={zoneType}
                    onChange={(event) => setZoneType(event.target.value)}
                  >
                    <option value="drs">DRS</option>
                    <option value="drs-detection">DRS detection</option>
                    <option value="yellow-flag">Yellow flag</option>
                    <option value="no-overtaking">No overtaking</option>
                    <option value="speed-limit">Speed limit</option>
                    <option value="pit-speed-limit">Pit speed limit</option>
                  </select>
                </label>
                <label>
                  Path
                  <select
                    value={zonePathId}
                    onChange={(event) => setZonePathId(event.target.value)}
                  >
                    <option value="primary">Primary circuit</option>
                    <option value={pitId}>Pit path</option>
                  </select>
                </label>
              </>
            )}
            {tool === "props" && (
              <label>
                Prop type
                <select
                  value={propType}
                  onChange={(event) =>
                    setPropType(event.target.value as TrackProp["type"])
                  }
                >
                  {[
                    "tree",
                    "light",
                    "barrier",
                    "grandstand",
                    "marshal-post",
                    "sign",
                  ].map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>
            )}
            {tool === "pit" && (
              <section aria-label="Pit construction">
                <p>
                  {legacyPit
                    ? "This saved lane uses Bézier points. Its geometry is preserved until you rebuild it."
                    : "Build an open lane from straights and curves. Choose a piece above. The first piece snaps to the main centerline; later pieces snap to pit connectors."}
                </p>
                {legacyPit ? (
                  <button
                    className="wide-button"
                    onClick={() => {
                      commit(
                        rebuildPitWithModules(document, pitId),
                        "Rebuild pit with modules",
                      );
                      setSelectedPathPointId(undefined);
                    }}
                  >
                    Rebuild with modules
                  </button>
                ) : (
                  <>
                    <label>
                      Pit lane width
                      <input
                        type="number"
                        min="2"
                        value={
                          pitPath?.widthMeters ?? placementParameters.width ?? 6
                        }
                        onChange={(event) => {
                          const width = Math.max(2, Number(event.target.value));
                          setPlacementParameters((current) => ({
                            ...current,
                            width,
                          }));
                          if (pitPath) {
                            const next = cloneDocument(document);
                            const path = next.paths.find(
                              (path) => path.id === pitId,
                            )!;
                            path.widthMeters = width;
                            next.modules
                              .filter((module) =>
                                path.sourceModuleIds.includes(module.id),
                              )
                              .forEach((module) => {
                                module.parameters.width = width;
                              });
                            commit(next, "Change pit lane width");
                          }
                        }}
                      />
                    </label>
                    <button
                      className="wide-button"
                      onClick={() => {
                        setPlacingDefinitionId(undefined);
                        setPlacementPreview(undefined);
                      }}
                    >
                      Select pit modules
                    </button>
                    <button
                      className="wide-button"
                      onClick={() =>
                        commit(
                          connectMatchingConnectors(document, pitId),
                          "Connect pit modules",
                        )
                      }
                    >
                      Connect pit modules
                    </button>
                    <button
                      className="wide-button"
                      disabled={!allGeometries[pitId]}
                      onClick={() => {
                        try {
                          commit(
                            attachPitEndpoints(document, pitId),
                            "Attach pit entry and exit",
                          );
                        } catch (error) {
                          setNotice(String(error));
                        }
                      }}
                    >
                      Attach entry / exit
                    </button>
                  </>
                )}
                <button
                  className="wide-button"
                  onClick={() => {
                    selectTool("markers");
                    setMarkerType("pit-entry");
                  }}
                >
                  Place Pit Entry
                </button>
                <button
                  className="wide-button"
                  onClick={() => {
                    selectTool("markers");
                    setMarkerType("pit-exit");
                  }}
                >
                  Place Pit Exit
                </button>
                <button
                  className="wide-button"
                  disabled={!allGeometries[pitId]}
                  onClick={addPitBox}
                >
                  Add pit box
                </button>
                {document.pitBoxes
                  .filter((box) => box.pathId === pitId)
                  .map((box) => (
                    <div key={box.id}>
                      Box {box.order} · {box.distanceMeters.toFixed(1)} m{" "}
                      <button
                        className="wide-button"
                        onClick={() => {
                          const next = cloneDocument(document);
                          next.pitBoxes = next.pitBoxes.filter(
                            (item) => item.id !== box.id,
                          );
                          commit(next, "Remove pit box");
                        }}
                      >
                        Remove box {box.order}
                      </button>
                    </div>
                  ))}
              </section>
            )}
            {tool === "terrain" && (
              <>
                <label>
                  Brush mode
                  <select
                    value={terrainMode}
                    onChange={(event) =>
                      setTerrainMode(
                        event.target.value as
                          "raise" | "lower" | "smooth" | "flatten",
                      )
                    }
                  >
                    <option value="raise">Raise</option>
                    <option value="lower">Lower</option>
                    <option value="smooth">Smooth</option>
                    <option value="flatten">Flatten</option>
                  </select>
                </label>
                <label>
                  Brush size
                  <input
                    type="range"
                    min="1"
                    max="8"
                    value={terrainBrush}
                    onChange={(event) =>
                      setTerrainBrush(Number(event.target.value))
                    }
                  />
                </label>
                <label>
                  Strength
                  <input
                    type="range"
                    min="0.1"
                    max="4"
                    step="0.1"
                    value={terrainStrength}
                    onChange={(event) =>
                      setTerrainStrength(Number(event.target.value))
                    }
                  />
                </label>
                {terrainMode === "flatten" && (
                  <label>
                    Target height (m)
                    <input
                      type="number"
                      step="0.1"
                      value={flattenHeight}
                      onChange={(event) =>
                        setFlattenHeight(Number(event.target.value))
                      }
                    />
                  </label>
                )}
                <button className="wide-button" onClick={trackFollowsTerrain}>
                  Track follows terrain
                </button>
                <button className="wide-button" onClick={terrainFollowsTrack}>
                  Terrain follows track
                </button>
              </>
            )}
          </div>
          {tool === "elevation" && geometry && (
            <section className="tool-options">
              <strong>Elevation profile</strong>
              <svg
                viewBox="0 0 200 90"
                role="img"
                aria-label="Elevation along the lap"
              >
                <polyline
                  fill="none"
                  stroke="#70d7ff"
                  strokeWidth="2"
                  points={geometry.path.samples
                    .map((sample) => {
                      const elevations = geometry.path.samples.map(
                        (item) => item.position.z,
                      );
                      const min = Math.min(...elevations),
                        range = Math.max(1, Math.max(...elevations) - min);
                      return (
                        (sample.s / geometry.path.totalLengthMeters) * 200 +
                        "," +
                        (80 - ((sample.position.z - min) / range) * 70)
                      );
                    })
                    .join(" ")}
                />
              </svg>
              <p>
                Distance along lap → elevation (m). Select a module to edit its
                base and elevation change.
              </p>
            </section>
          )}
          {tool === "test" && (
            <section className="tool-options">
              <p>
                {ghostInfo.lap} laps · {(ghostInfo.progress * 100).toFixed(1)}%
                · {testElapsed.toFixed(3)} s
              </p>
              <button
                className="wide-button"
                disabled={!testGeometry || !report.valid}
                onClick={() => setTestRunning((value) => !value)}
              >
                {testRunning ? "Pause" : "Run ghost"}
              </button>
              <button
                className="wide-button"
                disabled={!testGeometry || !report.valid || testRunning}
                onClick={() => {
                  if (testGeometry)
                    setGhost((current) =>
                      stepGhost(
                        current,
                        testGeometry.path,
                        document.markers,
                        testPathId,
                        1,
                        startDistance,
                        document.zones,
                      ),
                    );
                }}
              >
                Step ghost
              </button>
              <button
                className="wide-button"
                onClick={() => {
                  setTestRunning(false);
                  setGhost(createGhost());
                }}
              >
                Reset ghost
              </button>
              {ghost.events.slice(-5).map((event, index) => (
                <p key={index}>
                  {event.type}: {event.timeSeconds.toFixed(3)} s
                </p>
              ))}
            </section>
          )}
          {savedTracks && (
            <section className="tool-options">
              <strong>Saved tracks</strong>
              {savedTracks.map((track) => (
                <button
                  className="wide-button"
                  key={track.id}
                  onClick={() => void openSavedTrack(track.id)}
                >
                  {track.name}
                </button>
              ))}
            </section>
          )}
          {tool === "spectator" && (
            <section className="inspector-content">
              {(["top", "right", "bottom", "left"] as const).map((side) => (
                <label key={side}>
                  {side} margin
                  <input
                    type="number"
                    min="0"
                    value={document.spectatorFrame.margins[side]}
                    onChange={(event) => {
                      const next = cloneDocument(document);
                      next.spectatorFrame.margins[side] = Math.max(
                        0,
                        Number(event.target.value),
                      );
                      commit(next, "Edit frame margin");
                    }}
                  />
                </label>
              ))}
              <label>
                Frame rotation
                <input
                  type="number"
                  value={(document.spectatorFrame.rotation * 180) / Math.PI}
                  onChange={(event) => {
                    const next = cloneDocument(document);
                    next.spectatorFrame.rotation =
                      (Number(event.target.value) * Math.PI) / 180;
                    commit(next, "Rotate spectator frame");
                  }}
                />
              </label>
            </section>
          )}
          {tool === "markers" && (
            <section className="tool-options">
              {document.markers.map((marker) => (
                <button
                  className="wide-button"
                  key={marker.id}
                  onClick={() => {
                    setSelectedMarkerId(marker.id);
                    setSelectedZoneId(undefined);
                  }}
                >
                  {marker.configuration.label ?? marker.type}
                </button>
              ))}
            </section>
          )}
          {tool === "zones" && (
            <section className="tool-options">
              {document.zones.map((zone) => (
                <button
                  className="wide-button"
                  key={zone.id}
                  onClick={() => {
                    setSelectedZoneId(zone.id);
                    setSelectedMarkerId(undefined);
                  }}
                >
                  {zone.type}
                </button>
              ))}
            </section>
          )}
          {tool === "grid" && (
            <section className="inspector-content">
              <p>Per-slot offsets, in meters</p>
              {Array.from({ length: document.grid.slotCount }, (_, i) => (
                <div key={i}>
                  {(
                    ["distanceOffsetMeters", "lateralOffsetMeters"] as const
                  ).map((field) => (
                    <label key={field}>
                      Slot {i + 1}{" "}
                      {field === "distanceOffsetMeters"
                        ? "distance"
                        : "lateral"}
                      <input
                        type="number"
                        value={
                          document.grid.slots.find(
                            (slot) => slot.slot === i + 1,
                          )?.[field] ?? 0
                        }
                        onChange={(event) => {
                          const next = cloneDocument(document);
                          let slot = next.grid.slots.find(
                            (slot) => slot.slot === i + 1,
                          );
                          if (!slot) {
                            slot = { slot: i + 1 };
                            next.grid.slots.push(slot);
                          }
                          slot[field] = Number(event.target.value);
                          commit(next, "Edit grid slot");
                        }}
                      />
                    </label>
                  ))}
                </div>
              ))}
            </section>
          )}
          <div className="panel-hint">
            Racing Line uses Bézier points. Pit lanes use the track module
            palette. Terrain edits are reversible strokes.
          </div>
        </aside>
        <main className="canvas-area">
          <CanvasViewport
            document={document}
            viewport={viewport}
            selectedModuleId={selectedModuleId}
            selectedPathPointId={selectedPathPointId}
            selectedPropId={selectedPropId}
            placingDefinitionId={placingDefinitionId}
            placementPreview={placementPreview}
            placementStatus={placementStatus}
            placementModule={placement?.module}
            spectatorPreview={spectatorPreview}
            tool={tool}
            showCenterline={showCenterline}
            spectatorVisible={spectatorVisible}
            testDistance={testDistance}
            testPathId={testPathId}
            penPoints={penPoints}
            onViewportChange={setViewport}
            onSelectModule={(idValue) => {
              setSelectedModuleId(idValue);
              setSelectedPropId(undefined);
              setSelectedPathPointId(undefined);
              if (idValue)
                setTool(
                  document.paths.find((path) =>
                    path.sourceModuleIds.includes(idValue),
                  )?.kind === "pit"
                    ? "pit"
                    : "select",
                );
            }}
            onSelectPathPoint={(pathId, idValue) => {
              if (pathId.startsWith("module:")) {
                setSelectedPathPointId(idValue);
                return;
              }
              void pathId;
              setSelectedPathPointId(idValue);
              setSelectedModuleId(undefined);
              setSelectedPropId(undefined);
            }}
            onSelectProp={(idValue) => {
              setSelectedPropId(idValue);
              setSelectedModuleId(undefined);
              setSelectedPathPointId(undefined);
            }}
            onPlaceModule={addModule}
            onAddMarker={addMarkerAtPoint}
            onAddPathPoint={addPathPoint}
            onMovePathPoint={movePathPoint}
            onMovePathHandle={(pathId, pointId, handle, position) => {
              if (pathId.startsWith("module:")) {
                moveModuleControl(pathId.slice(7), pointId, position, handle);
                return;
              }
              startTransient();
              const next = cloneDocument(documentRef.current);
              const point = next.paths
                .find((path) => path.id === pathId)
                ?.controlPoints?.find((point) => point.id === pointId);
              if (point)
                point[handle] = {
                  x: position.x - point.position.x,
                  y: position.y - point.position.y,
                };
              updateDraft(next);
            }}
            onAddZone={addZone}
            onAddProp={addProp}
            onSetSpectatorCenter={setSpectatorCenter}
            onTerrainStroke={sculptTerrain}
            onMoveModule={moveModule}
            onMoveProp={moveProp}
            onPlacementPreview={setPlacementPreview}
            onCommitMove={finishTransient}
            onCancelMove={cancelTransient}
          />
          <div className="canvas-toolbar">
            <button
              onClick={() => {
                const next = connectMatchingConnectors(
                  document,
                  constructionPathId,
                );
                commit(
                  next,
                  next.connections.length > document.connections.length
                    ? "Connect matching ends"
                    : "No matching ends found",
                );
              }}
            >
              {tool === "pit" ? "Connect Pit" : "Close Circuit"}
            </button>
            <button onClick={fitTrack}>Fit Editor</button>
            <button onClick={fitSpectatorFrame}>Fit Frame</button>
            <button
              className={showCenterline ? "active" : ""}
              onClick={() => setShowCenterline((value) => !value)}
            >
              Centerline
            </button>
            <button
              className={spectatorVisible ? "active" : ""}
              onClick={() => setSpectatorVisible((value) => !value)}
            >
              Spectator Frame
            </button>
            <button
              className={spectatorPreview ? "active" : ""}
              onClick={() => setSpectatorPreview((value) => !value)}
            >
              Preview Race Frame
            </button>
          </div>
          <div className="statusbar">
            <span>{notice}</span>
            <span>
              {tool === "racing-line"
                ? "Bezier path editing"
                : tool === "pit"
                  ? "Modular pit construction"
                  : tool === "terrain"
                    ? "Terrain heightmap"
                    : "World coordinates · meters"}
            </span>
            <span>
              {testRunning
                ? `Ghost ${testElapsed.toFixed(1)}s · ${testDistance.toFixed(1)}m`
                : `Zoom ${viewport.zoom.toFixed(1)}×`}
            </span>
          </div>
        </main>
        <aside className="right-panel">
          {(tool === "spectator" || spectatorPreview) && (
            <FrameControls
              frame={document.spectatorFrame}
              change={(frame) =>
                commit(
                  { ...document, spectatorFrame: frame },
                  "Edit race frame coverage",
                )
              }
              fit={fitSpectatorFrame}
            />
          )}
          <details className="tool-options">
            <summary>Crossing settings</summary>
            <CommitNumber
              label="Minimum clearance (m)"
              value={document.minimumClearanceMeters ?? 5}
              min={0.1}
              step={0.1}
              onChange={(minimumClearanceMeters) =>
                commit(
                  { ...document, minimumClearanceMeters },
                  "Edit crossing clearance",
                )
              }
            />
          </details>
          <div className="inspector-heading">
            <div>
              <span className="eyebrow">INSPECTOR</span>
              <h2>
                {selectedMarker
                  ? "Marker"
                  : selectedZone
                    ? "Zone"
                    : selectedModule
                      ? "Module"
                      : selectedPoint
                        ? "Path Point"
                        : selectedProp
                          ? "Prop"
                          : "Circuit"}
              </h2>
            </div>
            <span className="status-dot" />
          </div>
          {selectedMarker ? (
            <div className="inspector-content">
              <label>
                Marker distance
                <input
                  type="number"
                  value={selectedMarker.location.distanceMeters}
                  onChange={(event) => {
                    const next = cloneDocument(document);
                    const marker = next.markers.find(
                      (item) => item.id === selectedMarker.id,
                    )!;
                    marker.location.distanceMeters = Number(event.target.value);
                    marker.location.anchor = undefined;
                    commit(next, "Edit marker distance");
                  }}
                />
              </label>
              <label>
                Marker label
                <input
                  value={String(selectedMarker.configuration.label ?? "")}
                  onChange={(event) => {
                    const next = cloneDocument(document);
                    next.markers.find(
                      (item) => item.id === selectedMarker.id,
                    )!.configuration.label = event.target.value;
                    commit(next, "Edit marker label");
                  }}
                />
              </label>
              <button className="wide-button" onClick={deleteSelected}>
                Delete marker
              </button>
            </div>
          ) : selectedZone ? (
            <div className="inspector-content">
              {(["startMeters", "endMeters"] as const).map((field) => (
                <label key={field}>
                  {field}
                  <input
                    type="number"
                    value={selectedZone[field]}
                    onChange={(event) => {
                      const next = cloneDocument(document);
                      next.zones.find((item) => item.id === selectedZone.id)![
                        field
                      ] = Number(event.target.value);
                      commit(next, "Edit zone range");
                    }}
                  />
                </label>
              ))}
              <label>
                Speed limit (km/h)
                <input
                  type="number"
                  min="1"
                  value={Number(selectedZone.properties.speedLimitKph ?? 60)}
                  onChange={(event) => {
                    const next = cloneDocument(document);
                    next.zones.find(
                      (item) => item.id === selectedZone.id,
                    )!.properties.speedLimitKph = Math.max(
                      1,
                      Number(event.target.value),
                    );
                    commit(next, "Edit zone speed");
                  }}
                />
              </label>
              <button className="wide-button" onClick={deleteSelected}>
                Delete zone
              </button>
            </div>
          ) : selectedModule ? (
            <ModuleInspector
              module={selectedModule}
              onRotate={rotateSelected}
              onDuplicate={duplicateSelected}
              onDelete={deleteSelected}
              onParameter={updateSelectedModuleParameter}
              onProperty={updateSelectedModuleProperty}
              onControls={(points) => {
                const next = cloneDocument(document);
                next.modules.find(
                  (m) => m.id === selectedModule.id,
                )!.controlPoints = points;
                commit(next, "Edit freeform controls");
              }}
            />
          ) : selectedPoint && selectedPath ? (
            <PathPointInspector
              point={selectedPoint}
              onHandle={updateSelectedPointHandle}
              onDelete={deleteSelected}
            />
          ) : selectedProp ? (
            <PropInspector
              prop={selectedProp}
              onChange={(field, value) => {
                const next = cloneDocument(document);
                const prop = next.props.find(
                  (item) => item.id === selectedProp.id,
                );
                if (prop)
                  (prop as unknown as Record<string, unknown>)[field] = value;
                commit(next, `Edit prop ${field}`);
              }}
              onDelete={deleteSelected}
            />
          ) : (
            <CircuitInspector
              document={document}
              stats={stats}
              onTheme={changeTheme}
              onGrid={updateGrid}
              onGridPattern={updateGridPattern}
              onEnvironment={(field, value) => {
                const next = cloneDocument(document);
                if (field === "runoff")
                  next.environment.runoff =
                    value as TrackDocument["environment"]["runoff"];
                if (field === "barrier")
                  next.environment.barrier =
                    value as TrackDocument["environment"]["barrier"];
                if (field === "kerb")
                  next.environment.kerb =
                    value as TrackDocument["environment"]["kerb"];
                commit(next, `Edit ${field}`);
              }}
              onFitFrame={fitSpectatorFrame}
            />
          )}
          {reportPanel(report, focusIssue)}
        </aside>
      </div>
      <footer className="bottom-panel">
        <div>
          <span className="live-indicator" /> LOCAL-FIRST WORKSPACE
        </div>
        <div>
          Paths {Object.keys(allGeometries).length} · Pit boxes{" "}
          {document.pitBoxes.length} · Props {document.props.length} · Zones{" "}
          {document.zones.length}
        </div>
        <div>
          Undo {history.length} ·{" "}
          {testRunning
            ? `ghost ${testDistance.toFixed(1)} m`
            : "Test mode ready"}
        </div>
      </footer>
    </div>
  );
}

function ModuleInspector({
  module,
  onRotate,
  onDuplicate,
  onDelete,
  onParameter,
  onProperty,
  onControls,
}: {
  module: TrackModule;
  onDuplicate: () => void;
  onRotate: () => void;
  onDelete: () => void;
  onParameter: (name: string, value: number) => void;
  onProperty: (name: "surface" | "kerb", value: string) => void;
  onControls: (points: NonNullable<TrackModule["controlPoints"]>) => void;
}) {
  return (
    <div className="inspector-content">
      <label>
        Module type
        <input
          value={
            getModuleDefinition(module.definitionId)?.label ??
            module.definitionId
          }
          readOnly
        />
      </label>
      <label>
        Position X
        <input
          type="number"
          value={module.transform.position.x.toFixed(2)}
          onChange={(event) => onParameter("__x", Number(event.target.value))}
        />
      </label>
      <label>
        Position Y
        <input
          type="number"
          value={module.transform.position.y.toFixed(2)}
          onChange={(event) => onParameter("__y", Number(event.target.value))}
        />
      </label>
      <label>
        Base elevation
        <input
          type="number"
          step="0.1"
          value={module.transform.position.z}
          onChange={(event) => onParameter("__z", Number(event.target.value))}
        />
      </label>
      <label>
        Elevation delta
        <input
          type="number"
          step="0.1"
          value={module.parameters.elevationDelta ?? 0}
          onChange={(event) =>
            onParameter("elevationDelta", Number(event.target.value))
          }
        />
      </label>
      {["straight", "curve-left", "curve-right"].includes(
        module.definitionId,
      ) ? (
        <>
          {module.definitionId === "straight" ? (
            <label>
              Length
              <input
                type="number"
                min="2"
                value={module.parameters.length}
                onChange={(event) =>
                  onParameter("length", Number(event.target.value))
                }
              />
            </label>
          ) : (
            <label>
              Radius
              <input
                type="number"
                min="3"
                value={module.parameters.radius ?? 30}
                onChange={(event) =>
                  onParameter("radius", Number(event.target.value))
                }
              />
            </label>
          )}
          <label>
            Angle (degrees)
            <input
              type="number"
              min="15"
              max="360"
              disabled={module.definitionId === "straight"}
              value={((module.parameters.angle ?? Math.PI / 2) * 180) / Math.PI}
              onChange={(event) =>
                onParameter(
                  "angle",
                  (Math.max(15, Math.min(360, Number(event.target.value))) *
                    Math.PI) /
                    180,
                )
              }
            />
          </label>
          <label>
            Width
            <input
              type="number"
              min="2"
              value={module.parameters.width}
              onChange={(event) =>
                onParameter("width", Number(event.target.value))
              }
            />
          </label>
        </>
      ) : (
        <ParameterFields
          module={module}
          change={(p) => {
            const changed = Object.entries(p).find(
              ([k, v]) => v !== module.parameters[k],
            );
            if (changed) onParameter(changed[0], changed[1]);
          }}
        />
      )}
      {module.controlPoints && (
        <section>
          <strong>Freeform control points</strong>
          <p>
            Drag points and handles on the canvas. Coordinates below are local
            meters.
          </p>
          {module.controlPoints.map((point, i) => (
            <details key={point.id}>
              <summary>Point {i + 1}</summary>
              {(["position", "inHandle", "outHandle"] as const).flatMap(
                (field) =>
                  (["x", "y"] as const).map((axis) => (
                    <CommitNumber
                      key={field + axis}
                      label={`Point ${i + 1} ${field} ${axis}`}
                      value={point[field][axis]}
                      onChange={(value) => {
                        const points = structuredClone(module.controlPoints!);
                        points[i][field][axis] = value;
                        onControls(points);
                      }}
                    />
                  )),
              )}
              <button
                disabled={module.controlPoints!.length <= 2}
                onClick={() =>
                  onControls(
                    module.controlPoints!.filter((p) => p.id !== point.id),
                  )
                }
              >
                Remove point {i + 1}
              </button>
            </details>
          ))}
          <button
            onClick={() => {
              const last = module.controlPoints!.at(-1)!;
              onControls([
                ...module.controlPoints!,
                {
                  ...structuredClone(last),
                  id: id("control"),
                  position: { ...last.position, x: last.position.x + 20 },
                },
              ]);
            }}
          >
            Add control point
          </button>
        </section>
      )}
      <label>
        Surface override
        <select
          value={module.properties?.surface ?? "default"}
          onChange={(event) =>
            onProperty(
              "surface",
              event.target.value === "default" ? "" : event.target.value,
            )
          }
        >
          <option value="default">Theme default</option>
          <option value="asphalt">Asphalt</option>
          <option value="concrete">Concrete</option>
          <option value="gravel">Gravel</option>
          <option value="sand">Sand</option>
          <option value="grass">Grass</option>
        </select>
      </label>
      <label>
        Kerb override
        <select
          value={module.properties?.kerb ?? "default"}
          onChange={(event) =>
            onProperty(
              "kerb",
              event.target.value === "default" ? "" : event.target.value,
            )
          }
        >
          <option value="default">Theme default</option>
          <option value="none">None</option>
          <option value="red-white">Red / white</option>
          <option value="blue-white">Blue / white</option>
        </select>
      </label>
      <div className="inspector-actions">
        <button onClick={onRotate}>Rotate 90°</button>
        <button onClick={onDuplicate}>Duplicate</button>
        <button className="danger-text" onClick={onDelete}>
          Delete
        </button>
      </div>
    </div>
  );
}

function PathPointInspector({
  point,
  onHandle,
  onDelete,
}: {
  point: NonNullable<TrackDocument["paths"][number]["controlPoints"]>[number];
  onHandle: (
    handle: "inHandle" | "outHandle",
    axis: "x" | "y",
    value: number,
  ) => void;
  onDelete: () => void;
}) {
  return (
    <div className="inspector-content">
      <label>
        Point X
        <input type="number" value={point.position.x.toFixed(2)} readOnly />
      </label>
      <label>
        Point Y
        <input type="number" value={point.position.y.toFixed(2)} readOnly />
      </label>
      {(["inHandle", "outHandle"] as const).map((handle) => (
        <div className="handle-grid" key={handle}>
          <span>{handle === "inHandle" ? "In handle" : "Out handle"}</span>
          <input
            type="number"
            value={point[handle].x.toFixed(2)}
            onChange={(event) =>
              onHandle(handle, "x", Number(event.target.value))
            }
          />
          <input
            type="number"
            value={point[handle].y.toFixed(2)}
            onChange={(event) =>
              onHandle(handle, "y", Number(event.target.value))
            }
          />
        </div>
      ))}
      <button className="wide-button danger-text" onClick={onDelete}>
        Delete point
      </button>
    </div>
  );
}

function PropInspector({
  prop,
  onChange,
  onDelete,
}: {
  prop: TrackProp;
  onChange: (field: string, value: string | number) => void;
  onDelete: () => void;
}) {
  return (
    <div className="inspector-content">
      <label>
        Type
        <select
          value={prop.type}
          onChange={(event) => onChange("type", event.target.value)}
        >
          {[
            "tree",
            "light",
            "barrier",
            "grandstand",
            "marshal-post",
            "sign",
          ].map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
      </label>
      <label>
        Scale
        <input
          type="number"
          min="0.1"
          step="0.1"
          value={prop.scale}
          onChange={(event) => onChange("scale", Number(event.target.value))}
        />
      </label>
      <label>
        Rotation
        <input
          type="number"
          value={((prop.rotation * 180) / Math.PI).toFixed(1)}
          onChange={(event) =>
            onChange("rotation", (Number(event.target.value) * Math.PI) / 180)
          }
        />
      </label>
      <button className="wide-button danger-text" onClick={onDelete}>
        Delete prop
      </button>
    </div>
  );
}

function CircuitInspector({
  document,
  stats,
  onTheme,
  onGrid,
  onGridPattern,
  onEnvironment,
  onFitFrame,
}: {
  document: TrackDocument;
  stats: ReturnType<typeof diagnostics>;
  onTheme: (id: string) => void;
  onGrid: (
    field: "slotCount" | "longitudinalSpacingMeters" | "lateralSpacingMeters",
    value: number,
  ) => void;
  onGridPattern: (value: "none" | "alternating" | "custom") => void;
  onEnvironment: (field: "runoff" | "barrier" | "kerb", value: string) => void;
  onFitFrame: () => void;
}) {
  return (
    <div className="inspector-content">
      <label>
        Current circuit
        <input value={document.metadata.name} readOnly />
      </label>
      <label>
        Theme
        <select
          value={document.theme.id}
          onChange={(event) => onTheme(event.target.value)}
        >
          {THEME_PACKS.map((theme) => (
            <option key={theme.id} value={theme.id}>
              {theme.name}
            </option>
          ))}
        </select>
      </label>
      <div className="stat-grid">
        <div>
          <small>LAP LENGTH</small>
          <strong>{stats.lapLengthMeters.toFixed(1)} m</strong>
        </div>
        <div>
          <small>MODULES</small>
          <strong>{document.modules.length}</strong>
        </div>
        <div>
          <small>MAX CURVATURE</small>
          <strong>{stats.maxCurvature.toFixed(3)}</strong>
        </div>
        <div>
          <small>MAX GRADE</small>
          <strong>{(stats.maxGrade * 100).toFixed(1)}%</strong>
        </div>
        <div>
          <small>ELEVATION GAIN</small>
          <strong>{stats.elevationGainMeters.toFixed(1)} m</strong>
        </div>
        <div>
          <small>GRID SLOTS</small>
          <strong>{document.grid.slotCount}</strong>
        </div>
      </div>
      <label>
        Grid slots
        <input
          type="number"
          min="1"
          value={document.grid.slotCount}
          onChange={(event) => onGrid("slotCount", Number(event.target.value))}
        />
      </label>
      <label>
        Grid spacing
        <input
          type="number"
          min="0.5"
          value={document.grid.longitudinalSpacingMeters}
          onChange={(event) =>
            onGrid("longitudinalSpacingMeters", Number(event.target.value))
          }
        />
      </label>
      <label>
        Lateral spacing
        <input
          type="number"
          min="0.5"
          value={document.grid.lateralSpacingMeters}
          onChange={(event) =>
            onGrid("lateralSpacingMeters", Number(event.target.value))
          }
        />
      </label>
      <label>
        Stagger pattern
        <select
          value={document.grid.staggerPattern}
          onChange={(event) =>
            onGridPattern(
              event.target.value as "none" | "alternating" | "custom",
            )
          }
        >
          <option value="none">None</option>
          <option value="alternating">Alternating</option>
          <option value="custom">Custom</option>
        </select>
      </label>
      <label>
        Runoff
        <select
          value={document.environment.runoff}
          onChange={(event) =>
            onEnvironment(
              "runoff",
              event.target.value as TrackDocument["environment"]["runoff"],
            )
          }
        >
          <option>grass</option>
          <option>gravel</option>
          <option>sand</option>
          <option>asphalt</option>
          <option>concrete</option>
        </select>
      </label>
      <label>
        Kerbs
        <select
          value={document.environment.kerb}
          onChange={(event) => onEnvironment("kerb", event.target.value)}
        >
          <option>none</option>
          <option>red-white</option>
          <option>blue-white</option>
          <option>yellow-black</option>
        </select>
      </label>
      <label>
        Barrier
        <select
          value={document.environment.barrier}
          onChange={(event) =>
            onEnvironment(
              "barrier",
              event.target.value as TrackDocument["environment"]["barrier"],
            )
          }
        >
          <option>none</option>
          <option>guardrail</option>
          <option>wall</option>
          <option>tire-stack</option>
          <option>fence</option>
        </select>
      </label>
      {stats.sectorLengths.length > 0 && (
        <div className="profile-list">
          <small>SECTOR LENGTHS</small>
          {stats.sectorLengths.map((sector) => (
            <div key={sector.id}>
              <span>{sector.id}</span>
              <strong>{sector.lengthMeters.toFixed(1)} m</strong>
            </div>
          ))}
        </div>
      )}
      {stats.pitLengthMeters > 0 && (
        <div className="profile-list">
          <small>PIT PATH</small>
          <div>
            <span>Length</span>
            <strong>{stats.pitLengthMeters.toFixed(1)} m</strong>
          </div>
        </div>
      )}
      <button className="wide-button" onClick={onFitFrame}>
        Fit spectator frame to circuit
      </button>
    </div>
  );
}

function reportPanel(
  report: ReturnType<typeof validateDocument>,
  focus: (entityIds: string[], location?: Vec2) => void,
) {
  return (
    <div className="diagnostics">
      <div className="diagnostics-title">
        <span>VALIDATION</span>
        <strong className={report.valid ? "valid" : "invalid"}>
          {report.valid
            ? "VALID"
            : `${report.issues.filter((item) => item.severity === "error").length} ERRORS`}
        </strong>
      </div>
      {report.issues.length === 0 ? (
        <p className="empty-state">
          No issues detected. The circuit is ready for test mode.
        </p>
      ) : (
        report.issues.map((item, index) => (
          <div
            role="button"
            tabIndex={0}
            onClick={() => focus(item.entityIds, item.location)}
            onKeyDown={(event) => {
              if (event.key === "Enter") focus(item.entityIds, item.location);
            }}
            key={`${item.code}-${index}`}
            className={`issue ${item.severity}`}
          >
            <span>{item.severity === "error" ? "!" : "i"}</span>
            <div>
              <strong>{item.message}</strong>
              <small>{item.suggestedFix}</small>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
