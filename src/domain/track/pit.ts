import type { TrackDocument, TrackModule, TrackPath, Vec2 } from "./types";
import {
  buildPathGeometry,
  buildTrackGeometry,
  connectMatchingConnectors,
  effectiveModule,
  getWorldConnector,
  modulePathId,
  modulesOverlap,
  snapModuleToOpenConnector,
} from "./geometry";
import { distance } from "./math";
import { moduleParameterErrors, createModuleGeometry } from "./modules";

export function pitPathId(document: TrackDocument): string {
  const existing = document.paths.find((path) => path.kind === "pit");
  if (existing) return existing.id;
  let id = "pit";
  for (let i = 2; document.paths.some((path) => path.id === id); i++)
    id = "pit-" + i;
  return id;
}
export function ensureModularPit(
  document: TrackDocument,
  pathId = pitPathId(document),
): TrackPath {
  let path = document.paths.find((path) => path.id === pathId);
  if (!path) {
    path = {
      id: pathId,
      kind: "pit",
      closed: false,
      sourceModuleIds: [],
      widthMeters: 6,
    };
    document.paths.push(path);
  }
  if (path.kind !== "pit" || path.controlPoints?.length)
    throw new Error(
      "Rebuild the saved Bézier pit with modules before adding pieces.",
    );
  return path;
}

function writeJunction(
  document: TrackDocument,
  path: TrackPath,
  type: "pit-entry" | "pit-exit",
  distanceMeters: number,
  relocate = false,
) {
  const primary = document.paths.find((path) => path.kind === "primary-loop")!;
  const reference = type === "pit-entry" ? "entryMarkerId" : "exitMarkerId";
  let marker =
    document.markers.find((marker) => marker.id === path[reference]) ??
    document.markers.find(
      (marker) => marker.type === type && marker.location.pathId === primary.id,
    );
  if (!marker) {
    const projection =
      buildTrackGeometry(document)!.path.sampleAtDistance(distanceMeters);
    marker = {
      id: type + "-" + crypto.randomUUID(),
      type,
      location: {
        pathId: primary.id,
        distanceMeters,
        anchor: { moduleId: projection.moduleId, localT: projection.localT },
      },
      configuration: { label: type },
    };
    document.markers.push(marker);
  }
  if (relocate) {
    const sample =
      buildTrackGeometry(document)!.path.sampleAtDistance(distanceMeters);
    marker.location = {
      pathId: primary.id,
      distanceMeters,
      anchor: { moduleId: sample.moduleId, localT: sample.localT },
    };
  }
  path[reference] = marker.id;
}

/** Only the localized entry/exit merge areas may overlap the main road. */
export function authoredModulesOverlap(
  document: TrackDocument,
  a: TrackModule,
  b: TrackModule,
): boolean {
  const aPath = document.paths.find(
    (path) => path.id === modulePathId(document, a.id),
  );
  const bPath = document.paths.find(
    (path) => path.id === modulePathId(document, b.id),
  );
  const pit =
    aPath?.kind === "pit" && bPath?.kind === "primary-loop"
      ? { path: aPath, module: a, main: b }
      : bPath?.kind === "pit" && aPath?.kind === "primary-loop"
        ? { path: bPath, module: b, main: a }
        : undefined;
  if (!pit)
    return modulesOverlap(
      a,
      b,
      undefined,
      document.minimumClearanceMeters ?? 5,
    );
  const primary = buildTrackGeometry(document)?.path;
  const positions: Vec2[] = [];
  for (const [field, type] of [
    ["entryMarkerId", "pit-entry"],
    ["exitMarkerId", "pit-exit"],
  ] as const) {
    const marker = document.markers.find((marker) =>
      pit.path[field] ? marker.id === pit.path[field] : marker.type === type,
    );
    if (
      marker &&
      primary &&
      document.paths.find((path) => path.id === marker.location.pathId)
        ?.kind === "primary-loop"
    )
      positions.push(
        primary.positionAtDistance(marker.location.distanceMeters),
      );
  }
  const radius =
    Math.max(
      pit.main.parameters.width ?? 10,
      pit.module.parameters.width ?? 6,
    ) * 1.5;
  return modulesOverlap(pit.module, pit.main, (point) =>
    positions.some((position) => distance(position, point) <= radius),
  );
}

export function prepareModulePlacement(
  document: TrackDocument,
  module: TrackModule,
  pathId: string,
  snapDistance: number,
  connectorId = "start",
  traversalId = "main",
) {
  let next = structuredClone(document);
  const primaryId = next.paths.find((path) => path.kind === "primary-loop")!.id;
  const path =
    next.paths.find((path) => path.id === pathId) ??
    ensureModularPit(next, pathId);
  if (path.kind === "pit" && path.sourceModuleIds.length === 0)
    path.widthMeters = module.parameters.width ?? 6;
  let candidate = module;
  const snapped = snapModuleToOpenConnector(
    next,
    candidate,
    snapDistance,
    path.id,
    connectorId,
  );
  candidate = snapped.module;
  let junctionSnap = false;
  const primary =
    path.kind === "pit" ? buildTrackGeometry(next)?.path : undefined;
  if (primary && path.sourceModuleIds.length === 0) {
    const marker = next.markers.find((marker) =>
      path.entryMarkerId
        ? marker.id === path.entryMarkerId
        : marker.type === "pit-entry" && marker.location.pathId === primaryId,
    );
    const projection = primary.nearestPoint(candidate.transform.position);
    const target = marker
      ? primary.positionAtDistance(marker.location.distanceMeters)
      : projection.position;
    if (distance(candidate.transform.position, target) <= snapDistance) {
      const s = marker?.location.distanceMeters ?? projection.distanceMeters;
      const tangent = primary.tangentAtDistance(s);
      candidate = {
        ...candidate,
        transform: {
          position: { ...target },
          rotation: Math.atan2(tangent.y, tangent.x),
        },
      };
      writeJunction(next, path, "pit-entry", s);
      junctionSnap = true;
    }
  }
  next.modules.push(candidate);
  path.sourceModuleIds.push(candidate.id);
  if (path.traversals || traversalId !== "main") {
    path.traversals ??= path.sourceModuleIds
      .slice(0, -1)
      .map((moduleId) => ({ moduleId, traversalId: "main", reversed: false }));
    const traversal = createModuleGeometry(
      candidate.definitionId,
      candidate.parameters,
      candidate.controlPoints,
    )?.traversals?.find((t) => t.id === traversalId);
    path.traversals.push({
      moduleId: candidate.id,
      traversalId,
      reversed: connectorId === traversal?.exit,
    });
  }
  if (snapped.connection)
    next.connections.push({
      id: "connection-" + crypto.randomUUID(),
      ...snapped.connection,
    });
  next = connectMatchingConnectors(next, path.id);
  const nextPath = next.paths.find((item) => item.id === path.id)!;
  if (primary && nextPath.sourceModuleIds.length > 1) {
    const lane = buildPathGeometry(next, path.id)?.path;
    const end = lane?.samples.at(-1)?.position;
    const projection = end && primary.nearestPoint(end);
    if (projection && projection.distanceToTrack <= 0.05) {
      writeJunction(next, nextPath, "pit-exit", projection.distanceMeters);
      junctionSnap = true;
    }
  }
  const p = candidate.parameters;
  const invalid =
    moduleParameterErrors(candidate).length > 0 ||
    next.modules.some(
      (other) =>
        other.id !== candidate.id &&
        authoredModulesOverlap(
          next,
          effectiveModule(next, candidate),
          effectiveModule(next, other),
        ),
    );
  return {
    document: next,
    module: candidate,
    status: invalid
      ? ("invalid" as const)
      : snapped.connection || junctionSnap
        ? ("snap" as const)
        : ("ready" as const),
  };
}

export function attachPitEndpoints(
  document: TrackDocument,
  pathId: string,
): TrackDocument {
  const next = structuredClone(document),
    path = next.paths.find((path) => path.id === pathId);
  const lane = buildPathGeometry(next, pathId)?.path,
    main = buildTrackGeometry(next)?.path;
  if (!path || !lane || !main)
    throw new Error("Connect all pit modules into one open lane first.");
  const endpoints = [lane.samples[0].position, lane.samples.at(-1)!.position];
  const projections = endpoints.map((point) => main.nearestPoint(point));
  if (projections.some((projection) => projection.distanceToTrack > 1))
    throw new Error(
      "Move the pit lane's start and end onto the main track centerline before attaching.",
    );
  projections.forEach((projection, index) =>
    writeJunction(
      next,
      path,
      index === 0 ? "pit-entry" : "pit-exit",
      projection.distanceMeters,
      true,
    ),
  );
  return next;
}

export function rebuildPitWithModules(
  document: TrackDocument,
  pathId: string,
): TrackDocument {
  const next = structuredClone(document),
    path = next.paths.find((path) => path.id === pathId);
  if (!path || path.sourceModuleIds.length) return next;
  delete path.controlPoints;
  path.closed = false;
  path.widthMeters ??= 6;
  return next;
}
