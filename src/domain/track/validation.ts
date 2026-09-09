import {
  buildPathGeometry,
  buildTrackGeometry,
  getWorldConnector,
  connectorsCompatible,
  effectiveModule,
  modulesOverlap,
  isPointDrivable,
  buildModulePaths,
} from "./geometry";
import type { TrackDocument, ValidationIssue, ValidationReport } from "./types";
import { distance, angleDelta } from "./math";
import { authoredModulesOverlap } from "./pit";
import { resolvedFacility } from "./catalog";
import { TrackDocumentSchema } from "./schema";
import {
  generateGrid,
  insideSpectatorFrame,
  spectatorTrackPoints,
} from "./authoring";
import { getModuleDefinition, moduleParameterErrors } from "./modules";

function issue(
  code: string,
  severity: ValidationIssue["severity"],
  message: string,
  entityIds: string[] = [],
  location?: { x: number; y: number },
  suggestedFix?: string,
): ValidationIssue {
  return { code, severity, message, entityIds, location, suggestedFix };
}

function orientation(
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number },
): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function segmentsIntersect(
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number },
  d: { x: number; y: number },
): boolean {
  const first = orientation(a, b, c);
  const second = orientation(a, b, d);
  const third = orientation(c, d, a);
  const fourth = orientation(c, d, b);
  return first * second < -1e-6 && third * fourth < -1e-6;
}

function hasSelfIntersection(
  points: Array<{ x: number; y: number; z?: number }>,
  allowAt?: (p: { x: number; y: number }) => boolean,
  clearance = 5,
): boolean {
  if (points.length < 6) return false;
  for (let first = 0; first < points.length - 1; first += 1) {
    for (let second = first + 2; second < points.length - 1; second += 1) {
      if (first === 0 && second === points.length - 2) continue;
      if (
        segmentsIntersect(
          points[first],
          points[first + 1],
          points[second],
          points[second + 1],
        )
      ) {
        const a = points[first],
          b = points[first + 1],
          c = points[second],
          d = points[second + 1];
        const dx = b.x - a.x,
          dy = b.y - a.y,
          ex = d.x - c.x,
          ey = d.y - c.y,
          determinant = dx * ey - dy * ex;
        const t = ((c.x - a.x) * ey - (c.y - a.y) * ex) / determinant,
          u = ((c.x - a.x) * dy - (c.y - a.y) * dx) / determinant;
        const zA = (a.z ?? 0) + ((b.z ?? 0) - (a.z ?? 0)) * t,
          zB = (c.z ?? 0) + ((d.z ?? 0) - (c.z ?? 0)) * u;
        if (
          Math.abs(zA - zB) >= clearance ||
          allowAt?.({ x: a.x + dx * t, y: a.y + dy * t })
        )
          continue;
        return true;
      }
    }
  }
  return false;
}

function validateCore(document: TrackDocument): ValidationReport {
  const issues: ValidationIssue[] = [];
  const schema = TrackDocumentSchema.safeParse(document);
  if (!schema.success)
    return {
      valid: false,
      generatedAt: Date.now(),
      issues: schema.error.issues.map((error) =>
        issue(
          error.path[0] === "terrain" ? "terrain.size" : "schema.malformed",
          "error",
          error.path.join(".") + ": " + error.message,
        ),
      ),
    };
  const allIds = [
    ...document.modules,
    ...document.connections,
    ...document.paths,
    ...document.markers,
    ...document.zones,
    ...document.props,
    ...document.pitBoxes,
    ...document.overrides,
    ...document.paths.flatMap((path) => path.controlPoints ?? []),
  ].map((item) => item.id);
  if (new Set(allIds).size !== allIds.length)
    issues.push(
      issue("entity.duplicate-id", "error", "Entity IDs must be unique."),
    );
  const primary = document.paths.filter((path) => path.kind === "primary-loop");
  if (primary.length !== 1)
    issues.push(
      issue(
        "path.primary",
        "error",
        "Exactly one primary circuit path is required.",
      ),
    );
  const owners = (id: string) =>
    document.paths.filter((path) => path.sourceModuleIds.includes(id));
  const crossings = document.modules
    .filter((m) => m.definitionId === "crossover")
    .map((m) => buildModulePaths(m));
  const allowedCrossing = (point: { x: number; y: number }) =>
    crossings.some(
      (paths) =>
        paths.length === 2 && paths.every((p) => isPointDrivable(p, point)),
    );
  const frame = document.spectatorFrame;
  if (
    frame.margins.left + frame.margins.right >= frame.size.x ||
    frame.margins.top + frame.margins.bottom >= frame.size.y
  )
    issues.push(
      issue(
        "spectator.margins",
        "error",
        "Frame margins leave no usable interior.",
        ["spectator-frame"],
      ),
    );
  if (
    frame.aspectRatio &&
    Math.abs(
      frame.size.x / frame.size.y - frame.aspectRatio.x / frame.aspectRatio.y,
    ) > 1e-6
  )
    issues.push(
      issue(
        "spectator.aspect-ratio",
        "error",
        "Frame coverage must match its selected aspect ratio.",
        ["spectator-frame"],
      ),
    );
  document.modules.forEach((module) => {
    const p = {
      ...getModuleDefinition(module.definitionId)!.defaultParameters,
      ...module.parameters,
    };
    if (moduleParameterErrors(module).length > 0)
      issues.push(
        issue(
          "module.parameters",
          "error",
          "Invalid length, width, radius or angle.",
          [module.id],
          module.transform.position,
        ),
      );
    if (owners(module.id).length === 0)
      issues.push(
        issue(
          "track.disconnected",
          "error",
          "Each module must belong to at least one route.",
          [module.id],
          module.transform.position,
        ),
      );
    if (module.definitionId === "crossover")
      issues.push(
        issue(
          "crossing.at-grade",
          "warning",
          "Intentional at-grade crossing: routes share a conflict area without changing direction.",
          [module.id],
          module.transform.position,
        ),
      );
    if (!moduleParameterErrors(module).length)
      for (const path of buildModulePaths(effectiveModule(document, module))) {
        if (
          hasSelfIntersection(path.samples.map((s) => s.position)) ||
          hasSelfIntersection(path.leftBoundary) ||
          hasSelfIntersection(path.rightBoundary)
        )
          issues.push(
            issue(
              "module.self-intersection",
              "error",
              "Module geometry folds or self-intersects.",
              [module.id],
              module.transform.position,
            ),
          );
      }
  });
  document.paths.forEach((path) => {
    if (
      path.traversals &&
      (new Set(path.traversals.map((s) => s.moduleId)).size !==
        path.sourceModuleIds.length ||
        path.traversals.some((s) => !path.sourceModuleIds.includes(s.moduleId)))
    )
      issues.push(
        issue(
          "path.traversal-membership",
          "error",
          "Route traversal references must match its source modules.",
          [path.id],
        ),
      );
    if (
      new Set(path.sourceModuleIds).size !== path.sourceModuleIds.length ||
      path.sourceModuleIds.some(
        (id) => !document.modules.some((module) => module.id === id),
      )
    )
      issues.push(
        issue(
          "path.module-reference",
          "error",
          "Path has duplicate or missing source modules.",
          [path.id],
        ),
      );
  });
  const occupied = new Set<string>();
  if (document.schemaVersion !== 1 && document.schemaVersion !== 2)
    issues.push(
      issue(
        "schema.unsupported",
        "error",
        "This document schema version is not supported.",
      ),
    );
  if (document.modules.length === 0)
    issues.push(
      issue("track.empty", "error", "Add at least one track module."),
    );
  const moduleIds = new Set(document.modules.map((item) => item.id));
  document.connections.forEach((connection) => {
    if (
      document.schemaVersion === 1 &&
      owners(connection.a.moduleId)[0]?.id !==
        owners(connection.b.moduleId)[0]?.id
    )
      issues.push(
        issue(
          "connection.cross-path",
          "error",
          "Module connectors must stay within their own path. Use Pit Entry/Exit for junctions.",
          [connection.id],
        ),
      );
    for (const reference of [connection.a, connection.b]) {
      const key = reference.moduleId + ":" + reference.connectorId;
      if (occupied.has(key))
        issues.push(
          issue(
            "connection.reused",
            "error",
            "A connector is used by more than one connection.",
            [connection.id, reference.moduleId],
          ),
        );
      occupied.add(key);
    }
    if (
      !moduleIds.has(connection.a.moduleId) ||
      !moduleIds.has(connection.b.moduleId)
    )
      issues.push(
        issue(
          "connection.missing-module",
          "error",
          "A connection references a module that no longer exists.",
          [connection.id],
        ),
      );
    if (
      connection.a.moduleId === connection.b.moduleId &&
      connection.a.connectorId === connection.b.connectorId
    )
      issues.push(
        issue(
          "connection.self",
          "error",
          "A connector cannot connect to itself.",
          [connection.id],
        ),
      );
    const aModule = document.modules.find(
      (module) => module.id === connection.a.moduleId,
    );
    const bModule = document.modules.find(
      (module) => module.id === connection.b.moduleId,
    );
    const a = aModule
      ? getWorldConnector(
          effectiveModule(document, aModule),
          connection.a.connectorId,
        )
      : undefined;
    const b = bModule
      ? getWorldConnector(
          effectiveModule(document, bModule),
          connection.b.connectorId,
        )
      : undefined;
    if (!a || !b)
      issues.push(
        issue(
          "connection.missing-connector",
          "error",
          "A connection references a missing connector.",
          [connection.id],
        ),
      );
    else if (!connectorsCompatible(a, b))
      issues.push(
        issue(
          "connection.incompatible",
          "error",
          "Connected ends must meet with opposing tangents, equal width and compatible elevation.",
          [connection.a.moduleId, connection.b.moduleId],
          a.position,
          "Align the modules or reconnect matching ends.",
        ),
      );
    if (a && b && Math.abs(a.position.z - b.position.z) > 0.5)
      issues.push(
        issue(
          "elevation.discontinuity",
          "warning",
          "Connected modules have a noticeable elevation discontinuity.",
          [connection.id],
          a.position,
          "Adjust module elevation or use a smoother transition.",
        ),
      );
  });
  const geometry = buildTrackGeometry(document);
  if (!geometry)
    issues.push(
      issue(
        "track.open-loop",
        "error",
        "The primary circuit is not a closed connected loop.",
        document.modules.map((item) => item.id),
        undefined,
        "Connect every open connector and close the circuit.",
      ),
    );
  const start = document.markers.filter(
    (marker) => marker.type === "start-finish",
  );
  if (start.length === 1 && start[0].location.pathId !== primary[0]?.id)
    issues.push(
      issue(
        "marker.start-primary",
        "error",
        "Start / Finish must be anchored to the primary circuit.",
        [start[0].id],
      ),
    );
  if (start.length !== 1)
    issues.push(
      issue(
        "marker.start-finish",
        "error",
        `The circuit must have exactly one Start/Finish marker; found ${start.length}.`,
        start.map((marker) => marker.id),
      ),
    );
  document.markers.forEach((marker) => {
    const anchor = marker.location.anchor;
    if (
      anchor &&
      (!document.paths
        .find((path) => path.id === marker.location.pathId)
        ?.sourceModuleIds.includes(anchor.moduleId) ||
        anchor.localT < 0 ||
        anchor.localT > 1)
    )
      issues.push(
        issue(
          "marker.anchor-unresolved",
          "warning",
          "Marker anchor no longer resolves; its authored distance is preserved.",
          [marker.id],
          undefined,
          "Reposition the marker to repair its anchor.",
        ),
      );
    if (
      marker.type === "start-finish" &&
      marker.location.pathId !== primary[0]?.id
    )
      issues.push(
        issue(
          "marker.start-path",
          "error",
          "Start/Finish must belong to the primary circuit.",
          [marker.id],
        ),
      );
    const markerPath = buildPathGeometry(document, marker.location.pathId);
    if (
      markerPath &&
      (marker.location.distanceMeters < 0 ||
        marker.location.distanceMeters > markerPath.path.totalLengthMeters)
    )
      issues.push(
        issue(
          "marker.distance-range",
          "warning",
          "Marker distance is outside the path range.",
          [marker.id],
        ),
      );

    if (!document.paths.some((path) => path.id === marker.location.pathId))
      issues.push(
        issue(
          "marker.path-missing",
          "error",
          "A marker references a path that does not exist.",
          [marker.id],
        ),
      );
    if (marker.location.distanceMeters < 0)
      issues.push(
        issue(
          "marker.distance-negative",
          "warning",
          "Marker distance is negative and will be wrapped around the path.",
          [marker.id],
        ),
      );
  });
  document.paths
    .filter((path) => path.kind !== "primary-loop")
    .forEach((path) => {
      const modular =
        path.sourceModuleIds.length > 0 ||
        (path.kind === "pit" && !path.controlPoints?.length);
      if (modular && !buildPathGeometry(document, path.id))
        issues.push(
          issue(
            "pit.open-chain",
            "error",
            "Route traversals must form a continuous explicitly connected chain.",
            [path.id],
          ),
        );
      if (path.sourceModuleIds.length && path.controlPoints?.length)
        issues.push(
          issue(
            "path.mixed-geometry",
            "error",
            "A path cannot use modules and Bézier points at the same time.",
            [path.id],
          ),
        );
      if (!modular && (path.controlPoints?.length ?? 0) < 2)
        issues.push(
          issue(
            "path.control-points",
            "error",
            `Path ${path.id} needs at least two control points.`,
            [path.id],
          ),
        );
      if (path.kind === "pit" && !path.closed && (path.widthMeters ?? 0) <= 0)
        issues.push(
          issue("pit.width", "error", "Pit path width must be positive.", [
            path.id,
          ]),
        );
      const pathGeometry = buildPathGeometry(document, path.id);
      if (pathGeometry && path.kind === "racing-line" && geometry) {
        const outside = pathGeometry.path.samples.some(
          (sample) => !isPointDrivable(geometry.path, sample.position),
        );
        if (outside)
          issues.push(
            issue(
              "racing-line.outside",
              "error",
              "The Racing Line leaves the drivable track boundaries.",
              [path.id],
              pathGeometry.path.samples.find(
                (sample) =>
                  geometry.path.nearestPoint(sample.position).distanceToTrack >
                  4,
              )?.position,
            ),
          );
      }
    });
  document.zones.forEach((zone) => {
    if (
      zone.type.includes("speed-limit") &&
      (!Number.isFinite(Number(zone.properties.speedKph ?? 80)) ||
        Number(zone.properties.speedKph ?? 80) <= 0)
    )
      issues.push(
        issue("zone.speed", "error", "Zone speed must be positive.", [zone.id]),
      );
    const path = document.paths.find((item) => item.id === zone.pathId);
    if (!path)
      issues.push(
        issue(
          "zone.path-missing",
          "error",
          "A zone references a path that does not exist.",
          [zone.id],
        ),
      );
    if (
      zone.endMeters === zone.startMeters ||
      (path && !path.closed && zone.endMeters < zone.startMeters)
    )
      issues.push(
        issue("zone.range", "error", "Zone end must be after its start.", [
          zone.id,
        ]),
      );
    const pathGeometry = path
      ? buildPathGeometry(document, path.id)
      : undefined;
    if (
      pathGeometry &&
      (zone.startMeters < 0 ||
        zone.endMeters < 0 ||
        zone.startMeters > pathGeometry.path.totalLengthMeters ||
        zone.endMeters > pathGeometry.path.totalLengthMeters)
    )
      issues.push(
        issue(
          "zone.range-overflow",
          "warning",
          "Zone distance is outside the path range.",
          [zone.id],
        ),
      );
  });
  const pitPath = document.paths.find((path) => path.kind === "pit");
  for (const marker of document.markers.filter(
    (m) => m.configuration.role === "drs-detection",
  )) {
    const zone = document.zones.find(
      (z) =>
        z.id === marker.configuration.zoneId &&
        z.type === "drs" &&
        z.pathId === marker.location.pathId,
    );
    if (!zone)
      issues.push(
        issue(
          "drs.activation-reference",
          "error",
          "DRS detection must reference an activation zone on the same route.",
          [marker.id],
        ),
      );
  }
  for (const source of document.props.filter(
    (p) => p.properties.facility === "pit-garage",
  )) {
    const pathId = String(source.properties.pathId),
      route = document.paths.find((p) => p.id === pathId),
      path = buildPathGeometry(document, pathId)?.path;
    if (
      !route ||
      route.kind !== "pit" ||
      !path ||
      Number(source.properties.distanceMeters) < 0 ||
      Number(source.properties.distanceMeters) > path.totalLengthMeters
    )
      issues.push(
        issue(
          "pit-garage.path",
          "error",
          "Garage frontage must be anchored within a valid pit route.",
          [source.id],
        ),
      );
    if (
      path &&
      isPointDrivable(path, resolvedFacility(document, source).position)
    )
      issues.push(
        issue(
          "pit-garage.road-overlap",
          "warning",
          "Garage frontage is inside the drivable pit lane; increase its setback.",
          [source.id],
        ),
      );
  }
  for (const route of document.paths.filter(
    (p) => p.metadata?.role === "service",
  )) {
    const path = buildPathGeometry(document, route.id)?.path;
    if (
      path &&
      [...path.leftBoundary, ...path.rightBoundary].some(
        (p) => !insideSpectatorFrame(document.spectatorFrame, p),
      )
    )
      issues.push(
        issue(
          "spectator.service-overflow",
          "warning",
          "An auxiliary service road is outside the spectator frame.",
          [route.id],
        ),
      );
  }
  const pitMarkers = document.markers.filter(
    (marker) => marker.type === "pit-entry" || marker.type === "pit-exit",
  );
  if (pitMarkers.length > 0 && !pitPath)
    issues.push(
      issue(
        "pit.path-missing",
        "error",
        "Pit markers require a pit path.",
        pitMarkers.map((marker) => marker.id),
      ),
    );
  if (
    pitPath &&
    pitMarkers.filter((marker) => marker.type === "pit-entry").length !== 1
  )
    issues.push(
      issue(
        "pit.entry",
        "error",
        "A pit path needs exactly one Pit Entry marker.",
        [pitPath.id],
      ),
    );
  if (
    pitPath &&
    pitMarkers.filter((marker) => marker.type === "pit-exit").length !== 1
  )
    issues.push(
      issue(
        "pit.exit",
        "error",
        "A pit path needs exactly one Pit Exit marker.",
        [pitPath.id],
      ),
    );
  if (pitPath) {
    const pit = buildPathGeometry(document, pitPath.id)?.path;
    if (pitPath.closed)
      issues.push(
        issue("pit.closed", "error", "Pit lane must be an open path.", [
          pitPath.id,
        ]),
      );
    for (const type of ["pit-entry", "pit-exit"] as const) {
      const markerId =
        type === "pit-entry" ? pitPath.entryMarkerId : pitPath.exitMarkerId;
      const marker = pitMarkers.find((item) =>
        markerId
          ? item.id === markerId && item.type === type
          : item.type === type,
      );
      if (markerId && !marker)
        issues.push(
          issue(
            "pit.marker-missing",
            "error",
            "The pit junction references a missing or incorrect marker.",
            [pitPath.id, markerId],
          ),
        );
      if (marker && marker.location.pathId !== primary[0]?.id)
        issues.push(
          issue(
            "pit.marker-path",
            "error",
            "Pit entry and exit must reference the primary circuit.",
            [marker.id],
          ),
        );
      if (pit && geometry && marker) {
        if (pitPath.sourceModuleIds.length) {
          const endpoint =
            type === "pit-entry" ? pit.samples[0] : pit.samples.at(-1)!;
          const main = geometry.path.sampleAtDistance(
            marker.location.distanceMeters,
          );
          if (
            Math.abs(endpoint.position.z - main.position.z) > 0.05 ||
            Math.abs(
              angleDelta(
                Math.atan2(endpoint.tangent.y, endpoint.tangent.x),
                Math.atan2(main.tangent.y, main.tangent.x),
              ),
            ) >
              Math.PI / 36
          )
            issues.push(
              issue(
                "pit.junction-alignment",
                "error",
                "Pit junction must match the main track elevation and travel direction.",
                [pitPath.id, marker.id],
                endpoint.position,
              ),
            );
        }
        const endpoint =
          type === "pit-entry"
            ? pit.samples[0].position
            : pit.samples.at(-1)!.position;
        if (
          distance(
            endpoint,
            geometry.path.positionAtDistance(marker.location.distanceMeters),
          ) > 1
        )
          issues.push(
            issue(
              "pit.reconnection",
              "error",
              "Pit path endpoint does not meet its entry or exit marker.",
              [pitPath.id, marker.id],
              endpoint,
            ),
          );
      }
    }
  }
  document.pitBoxes.forEach((box) => {
    const boxPath = buildPathGeometry(document, box.pathId)?.path;
    if (
      boxPath &&
      (box.distanceMeters < 0 ||
        box.distanceMeters > boxPath.totalLengthMeters ||
        Math.abs(box.lateralOffsetMeters) >
          boxPath.sampleAtDistance(box.distanceMeters).width / 2)
    )
      issues.push(
        issue("pit-box.outside", "error", "Pit box is outside its lane.", [
          box.id,
        ]),
      );

    if (!pitPath || box.pathId !== pitPath.id)
      issues.push(
        issue(
          "pit-box.path",
          "error",
          "A pit box must belong to the pit path.",
          [box.id],
        ),
      );
    if (box.speedLimitKph <= 0)
      issues.push(
        issue(
          "pit-box.speed",
          "error",
          "Pit box speed limit must be positive.",
          [box.id],
        ),
      );
  });
  if (
    document.terrain &&
    document.terrain.elevations.length !==
      document.terrain.width * document.terrain.height
  )
    issues.push(
      issue(
        "terrain.size",
        "error",
        "Terrain heightmap dimensions do not match its elevation data.",
        ["terrain"],
      ),
    );
  if (
    !document.grid.startMarkerId ||
    !start.some(
      (marker) =>
        marker.id === document.grid.startMarkerId &&
        marker.location.pathId === document.grid.pathId,
    )
  )
    issues.push(
      issue(
        "grid.start-missing",
        "error",
        "The starting grid references an invalid Start/Finish marker.",
        [document.grid.startMarkerId],
      ),
    );
  if (document.grid.slotCount < 1)
    issues.push(
      issue(
        "grid.empty",
        "error",
        "The starting grid must contain at least one slot.",
        [],
      ),
    );
  if (document.grid.longitudinalSpacingMeters <= 0)
    issues.push(
      issue(
        "grid.spacing",
        "error",
        "Grid longitudinal spacing must be positive.",
        [],
      ),
    );
  if (geometry) {
    const frame = document.spectatorFrame;
    const pitGeometry = pitPath
      ? buildPathGeometry(document, pitPath.id)
      : undefined;
    const pitBoundary = pitGeometry
      ? [...pitGeometry.path.leftBoundary, ...pitGeometry.path.rightBoundary]
      : [];
    const grid = generateGrid(document);
    if (document.grid.pathId !== primary[0]?.id)
      issues.push(
        issue(
          "grid.path",
          "error",
          "Starting grid must belong to the primary circuit.",
          ["grid"],
        ),
      );
    grid.forEach((slot) => {
      if (!isPointDrivable(geometry.path, slot.position))
        issues.push(
          issue(
            "grid.outside",
            "error",
            "Grid slot " + slot.slot + " is outside the drivable track.",
            ["grid"],
            slot.position,
          ),
        );
    });
    if (
      document.grid.slots.some((slot) => slot.slot > document.grid.slotCount) ||
      new Set(document.grid.slots.map((slot) => slot.slot)).size !==
        document.grid.slots.length
    )
      issues.push(
        issue(
          "grid.overrides",
          "error",
          "Grid overrides must reference unique existing slots.",
          ["grid"],
        ),
      );
    const outside = spectatorTrackPoints(document).some(
      (point) => !insideSpectatorFrame(frame, point),
    );
    document.props.forEach((source) => {
      const prop = resolvedFacility(document, source);
      if (!insideSpectatorFrame(frame, prop.position))
        issues.push(
          issue(
            "spectator.prop-overflow",
            "warning",
            "A decorative prop is outside the spectator frame.",
            [prop.id],
            prop.position,
          ),
        );
    });
    if (outside)
      issues.push(
        issue(
          frame.required ? "spectator.overflow" : "spectator.overflow-warning",
          frame.required ? "error" : "warning",
          "Track geometry extends outside the spectator camera frame.",
          ["spectator-frame"],
          frame.center,
          "Use Fit to Track or enlarge the frame.",
        ),
      );
    const narrow = geometry.path.samples.some((sample) => sample.width < 4);
    if (narrow)
      issues.push(
        issue(
          "track.narrow",
          "warning",
          "One or more sections are unusually narrow.",
          document.modules.map((item) => item.id),
        ),
      );
    if (geometry.path.totalLengthMeters < 20)
      issues.push(
        issue(
          "track.short",
          "warning",
          "The circuit is very short for a spectator race.",
          ["primary"],
        ),
      );
    const centerlinePoints = geometry.path.samples
      .filter((sample, i, all) => i === 0 || sample.s > all[i - 1].s + 1e-9)
      .map((sample) => sample.position);
    const boundaryPolygon = geometry.path.leftBoundary;
    if (
      hasSelfIntersection(
        centerlinePoints,
        allowedCrossing,
        document.minimumClearanceMeters ?? 5,
      )
    )
      issues.push(
        issue(
          "track.centerline-self-intersection",
          "error",
          "The centerline self-intersects.",
          ["primary"],
          undefined,
          "Separate crossing modules or change the curve layout.",
        ),
      );
    if (
      hasSelfIntersection(
        boundaryPolygon,
        allowedCrossing,
        document.minimumClearanceMeters ?? 5,
      ) ||
      hasSelfIntersection(
        geometry.path.rightBoundary,
        allowedCrossing,
        document.minimumClearanceMeters ?? 5,
      )
    )
      issues.push(
        issue(
          "track.boundary-self-intersection",
          "error",
          "The generated drivable boundary self-intersects.",
          ["primary"],
          undefined,
          "Increase track spacing or adjust module widths.",
        ),
      );
    const maximumGrade = Math.max(
      ...geometry.path.samples.map((sample, index, all) =>
        index === 0
          ? 0
          : Math.abs(sample.position.z - all[index - 1].position.z) /
            Math.max(0.001, distance(sample.position, all[index - 1].position)),
      ),
      0,
    );
    if (maximumGrade > 0.25)
      issues.push(
        issue(
          "elevation.grade-high",
          maximumGrade > 0.5 ? "error" : "warning",
          `Maximum grade is ${(maximumGrade * 100).toFixed(1)}%.`,
          ["primary"],
          undefined,
          "Reduce elevation delta or add a transition module.",
        ),
      );
  }
  for (let i = 0; i < document.modules.length; i++)
    for (let j = i + 1; j < document.modules.length; j++) {
      const a = effectiveModule(document, document.modules[i]),
        b = effectiveModule(document, document.modules[j]);
      if (authoredModulesOverlap(document, a, b))
        issues.push(
          issue(
            "track.overlap",
            "error",
            "Track modules overlap.",
            [a.id, b.id],
            a.transform.position,
            "Move modules apart.",
          ),
        );
    }
  const orderedMarkers = document.markers
    .filter(
      (marker) => marker.type === "sector" || marker.type === "checkpoint",
    )
    .sort((a, b) => a.location.distanceMeters - b.location.distanceMeters);
  orderedMarkers.forEach((marker, index) => {
    const previous = orderedMarkers[index - 1];
    if (
      previous &&
      marker.type === previous.type &&
      marker.location.pathId === previous.location.pathId &&
      Math.abs(
        marker.location.distanceMeters - previous.location.distanceMeters,
      ) < 0.1
    )
      issues.push(
        issue(
          "marker.ordering",
          "warning",
          "Timing markers of the same type occupy the same track position.",
          [previous.id, marker.id],
        ),
      );
  });
  document.modules.forEach((module) => {
    if (
      buildModulePaths(effectiveModule(document, module)).some((path) =>
        path.samples.some((sample) => sample.curvature * sample.width > 1),
      )
    )
      issues.push(
        issue(
          "track.excessive-curvature",
          "warning",
          "Corner radius is small relative to track width.",
          [module.id],
          module.transform.position,
        ),
      );
  });
  return {
    valid: !issues.some((item) => item.severity === "error"),
    issues,
    generatedAt: Date.now(),
  };
}

export interface ValidationRule {
  id: string;
  validate(document: TrackDocument): ValidationIssue[];
}
export const VALIDATION_RULES: readonly ValidationRule[] = [
  {
    id: "track-foundations",
    validate: (document) => validateCore(document).issues,
  },
];
export function validateDocument(
  document: TrackDocument,
  rules: readonly ValidationRule[] = VALIDATION_RULES,
): ValidationReport {
  // Always guard schema before invoking extension rules, even for incomplete imported data.
  const parsed = TrackDocumentSchema.safeParse(document);
  if (!parsed.success) return validateCore(document);
  const issues = rules.flatMap((rule) => rule.validate(document));
  return {
    valid: !issues.some((issue) => issue.severity === "error"),
    issues,
    generatedAt: Date.now(),
  };
}

export function diagnostics(document: TrackDocument) {
  const geometry = buildTrackGeometry(document);
  if (!geometry)
    return {
      lapLengthMeters: 0,
      elevationGainMeters: 0,
      elevationLossMeters: 0,
      maxCurvature: 0,
      minimumCornerRadiusMeters: 0,
      straightSections: 0,
      highSpeedSections: 0,
      lowSpeedSections: 0,
      brakingZones: 0,
      sectorLengths: [],
      pitLengthMeters: 0,
      racingLineMaxCurvature: 0,
      maxGrade: 0,
    };
  const straightSections = document.modules.filter(
    (module) =>
      module.definitionId === "straight" &&
      document.paths.some(
        (path) =>
          path.kind === "primary-loop" &&
          path.sourceModuleIds.includes(module.id),
      ),
  ).length;
  const primaryId = document.paths.find(
    (path) => path.kind === "primary-loop",
  )!.id;
  const boundaries = document.markers
    .filter(
      (marker) =>
        marker.location.pathId === primaryId &&
        (marker.type === "sector" || marker.type === "start-finish"),
    )
    .sort((a, b) => a.location.distanceMeters - b.location.distanceMeters);
  const sectorLengths = boundaries.map((marker, index) => ({
    id: marker.id,
    lengthMeters:
      boundaries.length === 1
        ? geometry.path.totalLengthMeters
        : geometry.path.wrapDistance(
            boundaries[(index + 1) % boundaries.length].location
              .distanceMeters - marker.location.distanceMeters,
          ),
  }));

  const pitPath = document.paths.find((path) => path.kind === "pit");
  const pitLengthMeters = pitPath
    ? (buildPathGeometry(document, pitPath.id)?.path.totalLengthMeters ?? 0)
    : 0;
  const racingLine = document.paths.find((path) => path.kind === "racing-line");
  const racingLineMaxCurvature = racingLine
    ? Math.max(
        ...(buildPathGeometry(document, racingLine.id)?.path.samples.map(
          (sample) => sample.curvature,
        ) ?? [0]),
      )
    : 0;
  const maxGrade = Math.max(
    ...geometry.path.samples.map((sample, index, all) =>
      index === 0
        ? 0
        : Math.abs(sample.position.z - all[index - 1].position.z) /
          Math.max(0.001, distance(sample.position, all[index - 1].position)),
    ),
    0,
  );
  const countRuns = (predicate: (curvature: number) => boolean) => {
    const flags = geometry.path.samples.map((sample) =>
      predicate(sample.curvature),
    );
    const runs = flags.filter(
      (flag, index) =>
        flag && !flags[(index + flags.length - 1) % flags.length],
    ).length;
    return runs || (flags.some(Boolean) ? 1 : 0);
  };
  const highSpeedSections = countRuns((curvature) => curvature < 0.01);
  const lowSpeedSections = countRuns((curvature) => curvature > 0.025);
  const brakingZones = geometry.path.samples.filter(
    (sample, index, all) =>
      index > 0 && sample.curvature - all[index - 1].curvature > 0.01,
  ).length;
  return {
    lapLengthMeters: geometry.path.totalLengthMeters,
    elevationGainMeters: geometry.path.samples.reduce(
      (sum, sample, index, all) =>
        index === 0
          ? sum
          : sum + Math.max(0, sample.position.z - all[index - 1].position.z),
      0,
    ),
    elevationLossMeters: geometry.path.samples.reduce(
      (sum, sample, index, all) =>
        index === 0
          ? sum
          : sum + Math.max(0, all[index - 1].position.z - sample.position.z),
      0,
    ),
    maxCurvature: Math.max(
      ...geometry.path.samples.map((sample) => sample.curvature),
      0,
    ),
    minimumCornerRadiusMeters: Math.min(
      ...geometry.path.samples
        .map((sample) =>
          sample.curvature > 0
            ? 1 / sample.curvature
            : Number.POSITIVE_INFINITY,
        )
        .filter(Number.isFinite),
      Number.POSITIVE_INFINITY,
    ),
    straightSections,
    highSpeedSections,
    lowSpeedSections,
    brakingZones,
    sectorLengths,
    pitLengthMeters,
    racingLineMaxCurvature,
    maxGrade,
  };
}
