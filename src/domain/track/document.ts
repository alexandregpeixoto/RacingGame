import type {
  TrackDocument,
  TrackModule,
  ModuleConnection,
  TrackMarker,
  TerrainHeightmap,
  PathControlPoint,
  TrackPath,
} from "./types";
import { TAU } from "./math";

export function id(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

export function createEmptyDocument(): TrackDocument {
  const now = new Date().toISOString();
  return {
    schemaVersion: 2,
    id: id("track"),
    metadata: {
      name: "Untitled Circuit",
      description: "",
      createdAt: now,
      updatedAt: now,
    },
    world: { units: "meters", upAxis: "z" },
    modules: [],
    connections: [],
    paths: [
      {
        id: "primary",
        kind: "primary-loop",
        closed: true,
        sourceModuleIds: [],
      },
    ],
    markers: [],
    zones: [],
    grid: {
      pathId: "primary",
      startMarkerId: "",
      slotCount: 8,
      longitudinalSpacingMeters: 8,
      lateralSpacingMeters: 3.5,
      staggerPattern: "alternating",
      slots: [],
    },
    spectatorFrame: {
      aspectRatio: { x: 16, y: 9 },
      center: { x: 0, y: 0 },
      size: { x: 200, y: 112.5 },
      rotation: 0,
      margins: { top: 8, right: 8, bottom: 8, left: 8 },
      required: true,
    },
    theme: { id: "base", name: "Base Motorsport" },
    overrides: [],
    props: [],
    environment: { runoff: "grass", barrier: "guardrail", kerb: "red-white" },
    terrain: createTerrain(),
    pitBoxes: [],
  };
}

export function createTerrain(width = 48, height = 48): TerrainHeightmap {
  return {
    width,
    height,
    cellSizeMeters: 8,
    origin: { x: (-width * 8) / 2, y: (-height * 8) / 2 },
    elevations: Array.from({ length: width * height }, () => 0),
  };
}

function moduleItem(
  idValue: string,
  definitionId: TrackModule["definitionId"],
  x: number,
  y: number,
  rotation: number,
  parameters: Record<string, number>,
): TrackModule {
  return {
    id: idValue,
    definitionId,
    transform: { position: { x, y, z: 0 }, rotation },
    parameters,
  };
}

function connection(
  idValue: string,
  aModule: string,
  aConnector: "start" | "end",
  bModule: string,
  bConnector: "start" | "end",
): ModuleConnection {
  return {
    id: idValue,
    a: { moduleId: aModule, connectorId: aConnector },
    b: { moduleId: bModule, connectorId: bConnector },
  };
}

export function createSampleDocument(): TrackDocument {
  const document = createEmptyDocument();
  const width = 10;
  const modules: TrackModule[] = [
    moduleItem("m-bottom", "straight", -40, 0, 0, {
      length: 80,
      width,
      elevationDelta: 0,
    }),
    moduleItem("m-right", "curve-left", 40, 0, 0, {
      radius: 30,
      angle: Math.PI,
      width,
      elevationDelta: 0,
    }),
    moduleItem("m-top", "straight", 40, 60, Math.PI, {
      length: 80,
      width,
      elevationDelta: 0,
    }),
    moduleItem("m-left", "curve-left", -40, 60, Math.PI, {
      radius: 30,
      angle: Math.PI,
      width,
      elevationDelta: 0,
    }),
  ];
  const startFinish: TrackMarker = {
    id: "marker-start",
    type: "start-finish",
    location: {
      pathId: "primary",
      distanceMeters: 0,
      anchor: { moduleId: "m-bottom", localT: 0 },
    },
    configuration: {},
  };
  document.modules = modules;
  document.connections = [
    connection("c-1", "m-bottom", "end", "m-right", "start"),
    connection("c-2", "m-right", "end", "m-top", "start"),
    connection("c-3", "m-top", "end", "m-left", "start"),
    connection("c-4", "m-left", "end", "m-bottom", "start"),
  ];
  document.paths[0].sourceModuleIds = modules.map((item) => item.id);
  document.markers = [
    startFinish,
    {
      id: "marker-sector-1",
      type: "sector",
      location: { pathId: "primary", distanceMeters: 130 },
      configuration: { label: "Sector 1" },
    },
  ];
  document.grid = { ...document.grid, startMarkerId: startFinish.id };
  document.spectatorFrame = {
    ...document.spectatorFrame,
    center: { x: 0, y: 30 },
    size: { x: 196, y: 110.25 },
  };
  document.theme = { id: "realistic", name: "Realistic Motorsport" };
  document.metadata.name = "Starter Oval";
  document.metadata.updatedAt = new Date().toISOString();
  return document;
}

export function cloneDocument(document: TrackDocument): TrackDocument {
  return structuredClone(document);
}

export function touch(document: TrackDocument): TrackDocument {
  return {
    ...document,
    metadata: { ...document.metadata, updatedAt: new Date().toISOString() },
  };
}

export function normalizeRotation(rotation: number): number {
  return ((rotation % TAU) + TAU) % TAU;
}

export function ensureControlPath(
  document: TrackDocument,
  idValue: string,
  kind: TrackPath["kind"],
  widthMeters: number,
  closed = false,
): TrackPath {
  const existing = document.paths.find((path) => path.id === idValue);
  if (existing) return existing;
  const path: TrackPath = {
    id: idValue,
    kind,
    closed,
    sourceModuleIds: [],
    widthMeters,
    controlPoints: [],
  };
  document.paths.push(path);
  return path;
}

export function createControlPoint(point: {
  x: number;
  y: number;
  z?: number;
}): PathControlPoint {
  return {
    id: id("point"),
    position: { x: point.x, y: point.y, z: point.z ?? 0 },
    inHandle: { x: 0, y: 0 },
    outHandle: { x: 0, y: 0 },
  };
}

export function hydrateDocument(document: TrackDocument): TrackDocument {
  return {
    ...document,
    zones: document.zones ?? [],
    props: document.props ?? [],
    environment: document.environment ?? {
      runoff: "grass",
      barrier: "guardrail",
      kerb: "red-white",
    },
    terrain: document.terrain ?? createTerrain(),
    pitBoxes: document.pitBoxes ?? [],
    paths: (document.paths ?? []).map((path) => ({
      ...path,
      sourceModuleIds: path.sourceModuleIds ?? [],
      controlPoints: path.controlPoints ?? undefined,
    })),
  };
}
