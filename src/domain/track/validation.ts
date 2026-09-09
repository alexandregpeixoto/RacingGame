import { buildPathGeometry, buildTrackGeometry, getWorldConnector } from "./geometry";
import type { TrackDocument, ValidationIssue, ValidationReport } from "./types";
import { distance } from "./math";

function issue(code: string, severity: ValidationIssue["severity"], message: string, entityIds: string[] = [], location?: { x: number; y: number }, suggestedFix?: string): ValidationIssue {
  return { code, severity, message, entityIds, location, suggestedFix };
}

function orientation(a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function segmentsIntersect(a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }, d: { x: number; y: number }): boolean {
  const first = orientation(a, b, c); const second = orientation(a, b, d); const third = orientation(c, d, a); const fourth = orientation(c, d, b);
  return first * second < -1e-6 && third * fourth < -1e-6;
}

function hasSelfIntersection(points: Array<{ x: number; y: number }>): boolean {
  if (points.length < 6) return false;
  for (let first = 0; first < points.length - 1; first += 1) {
    for (let second = first + 2; second < points.length - 1; second += 1) {
      if (first === 0 && second === points.length - 2) continue;
      if (segmentsIntersect(points[first], points[first + 1], points[second], points[second + 1])) return true;
    }
  }
  return false;
}

export function validateDocument(document: TrackDocument): ValidationReport {
  const issues: ValidationIssue[] = [];
  if (document.schemaVersion !== 1) issues.push(issue("schema.unsupported", "error", "This document schema version is not supported."));
  if (document.modules.length === 0) issues.push(issue("track.empty", "error", "Add at least one track module."));
  const moduleIds = new Set(document.modules.map((item) => item.id));
  document.connections.forEach((connection) => {
    if (!moduleIds.has(connection.a.moduleId) || !moduleIds.has(connection.b.moduleId)) issues.push(issue("connection.missing-module", "error", "A connection references a module that no longer exists.", [connection.id]));
    if (connection.a.moduleId === connection.b.moduleId && connection.a.connectorId === connection.b.connectorId) issues.push(issue("connection.self", "error", "A connector cannot connect to itself.", [connection.id]));
    const aModule = document.modules.find((module) => module.id === connection.a.moduleId);
    const bModule = document.modules.find((module) => module.id === connection.b.moduleId);
    const a = aModule ? getWorldConnector(aModule, connection.a.connectorId) : undefined;
    const b = bModule ? getWorldConnector(bModule, connection.b.connectorId) : undefined;
    if (a && b && Math.abs(a.position.z - b.position.z) > 0.5) issues.push(issue("elevation.discontinuity", "warning", "Connected modules have a noticeable elevation discontinuity.", [connection.id], a.position, "Adjust module elevation or use a smoother transition."));
  });
  const geometry = buildTrackGeometry(document);
  if (!geometry) issues.push(issue("track.open-loop", "error", "The primary circuit is not a closed connected loop.", document.modules.map((item) => item.id), undefined, "Connect every open connector and close the circuit."));
  const start = document.markers.filter((marker) => marker.type === "start-finish");
  if (start.length !== 1) issues.push(issue("marker.start-finish", "error", `The circuit must have exactly one Start/Finish marker; found ${start.length}.`, start.map((marker) => marker.id)));
  document.markers.forEach((marker) => {
    if (!document.paths.some((path) => path.id === marker.location.pathId)) issues.push(issue("marker.path-missing", "error", "A marker references a path that does not exist.", [marker.id]));
    if (marker.location.distanceMeters < 0) issues.push(issue("marker.distance-negative", "warning", "Marker distance is negative and will be wrapped around the path.", [marker.id]));
  });
  document.paths.filter((path) => path.kind !== "primary-loop").forEach((path) => {
    if ((path.controlPoints?.length ?? 0) < 2) issues.push(issue("path.control-points", "error", `Path ${path.id} needs at least two control points.`, [path.id]));
    if (path.kind === "pit" && !path.closed && (path.widthMeters ?? 0) <= 0) issues.push(issue("pit.width", "error", "Pit path width must be positive.", [path.id]));
    const pathGeometry = buildPathGeometry(document, path.id);
    if (pathGeometry && path.kind === "racing-line" && geometry) {
      const outside = pathGeometry.path.samples.some((sample) => geometry.path.nearestPoint(sample.position).distanceToTrack > geometry.path.sampleAtDistance(geometry.path.nearestPoint(sample.position).distanceMeters).width / 2);
      if (outside) issues.push(issue("racing-line.outside", "error", "The Racing Line leaves the drivable track boundaries.", [path.id], pathGeometry.path.samples.find((sample) => geometry.path.nearestPoint(sample.position).distanceToTrack > 4)?.position));
    }
  });
  document.zones.forEach((zone) => {
    const path = document.paths.find((item) => item.id === zone.pathId);
    if (!path) issues.push(issue("zone.path-missing", "error", "A zone references a path that does not exist.", [zone.id]));
    if (zone.endMeters <= zone.startMeters) issues.push(issue("zone.range", "error", "Zone end must be after its start.", [zone.id]));
    const pathGeometry = path ? buildPathGeometry(document, path.id) : undefined;
    if (pathGeometry && zone.endMeters > pathGeometry.path.totalLengthMeters) issues.push(issue("zone.range-overflow", "warning", "Zone end extends beyond the path and will be clamped.", [zone.id]));
  });
  const pitPath = document.paths.find((path) => path.kind === "pit");
  const pitMarkers = document.markers.filter((marker) => marker.type === "pit-entry" || marker.type === "pit-exit");
  if (pitMarkers.length > 0 && !pitPath) issues.push(issue("pit.path-missing", "error", "Pit markers require a pit path.", pitMarkers.map((marker) => marker.id)));
  if (pitPath && pitMarkers.filter((marker) => marker.type === "pit-entry").length !== 1) issues.push(issue("pit.entry", "error", "A pit path needs exactly one Pit Entry marker.", [pitPath.id]));
  if (pitPath && pitMarkers.filter((marker) => marker.type === "pit-exit").length !== 1) issues.push(issue("pit.exit", "error", "A pit path needs exactly one Pit Exit marker.", [pitPath.id]));
  document.pitBoxes.forEach((box) => {
    if (!pitPath || box.pathId !== pitPath.id) issues.push(issue("pit-box.path", "error", "A pit box must belong to the pit path.", [box.id]));
    if (box.speedLimitKph <= 0) issues.push(issue("pit-box.speed", "error", "Pit box speed limit must be positive.", [box.id]));
  });
  if (document.terrain && document.terrain.elevations.length !== document.terrain.width * document.terrain.height) issues.push(issue("terrain.size", "error", "Terrain heightmap dimensions do not match its elevation data.", ["terrain"]));
  if (document.grid.startMarkerId && !start.some((marker) => marker.id === document.grid.startMarkerId)) issues.push(issue("grid.start-missing", "error", "The starting grid references an invalid Start/Finish marker.", [document.grid.startMarkerId]));
  if (document.grid.slotCount < 1) issues.push(issue("grid.empty", "error", "The starting grid must contain at least one slot.", []));
  if (document.grid.longitudinalSpacingMeters <= 0) issues.push(issue("grid.spacing", "error", "Grid longitudinal spacing must be positive.", []));
  if (geometry) {
    const frame = document.spectatorFrame;
    const outside = geometry.path.leftBoundary.concat(geometry.path.rightBoundary).some((point) => Math.abs(point.x - frame.center.x) > frame.size.x / 2 || Math.abs(point.y - frame.center.y) > frame.size.y / 2);
    if (outside) issues.push(issue(frame.required ? "spectator.overflow" : "spectator.overflow-warning", frame.required ? "error" : "warning", "Track geometry extends outside the spectator camera frame.", ["spectator-frame"], frame.center, "Use Fit to Track or enlarge the frame."));
    const narrow = geometry.path.samples.some((sample) => sample.width < 4);
    if (narrow) issues.push(issue("track.narrow", "warning", "One or more sections are unusually narrow.", document.modules.map((item) => item.id)));
    if (geometry.path.totalLengthMeters < 20) issues.push(issue("track.short", "warning", "The circuit is very short for a spectator race.", ["primary"]));
    const duplicateSamples = geometry.path.samples.some((sample, index, all) => index > 0 && distance(sample.position, all[index - 1].position) < 0.001);
    if (duplicateSamples) issues.push(issue("track.duplicate-geometry", "error", "The generated centerline contains duplicate positions.", ["primary"]));
    let overlapFound = false;
    for (let first = 0; first < geometry.path.samples.length && !overlapFound; first += 1) {
      for (let second = first + 4; second < geometry.path.samples.length - 4; second += 1) {
        const a = geometry.path.samples[first]; const b = geometry.path.samples[second];
        if (a.moduleId !== b.moduleId && distance(a.position, b.position) < Math.min(a.width, b.width) * 0.45) { overlapFound = true; break; }
      }
    }
    if (overlapFound) issues.push(issue("track.overlap", "error", "Non-adjacent track geometry overlaps.", ["primary"], undefined, "Move modules apart or choose a different curve radius."));
    const centerlinePoints = geometry.path.samples.map((sample) => sample.position);
    const boundaryPolygon = geometry.path.leftBoundary.concat([...geometry.path.rightBoundary].reverse());
    if (hasSelfIntersection(centerlinePoints)) issues.push(issue("track.centerline-self-intersection", "error", "The centerline self-intersects.", ["primary"], undefined, "Separate crossing modules or change the curve layout."));
    if (hasSelfIntersection(boundaryPolygon)) issues.push(issue("track.boundary-self-intersection", "error", "The generated drivable boundary self-intersects.", ["primary"], undefined, "Increase track spacing or adjust module widths."));
    const maximumGrade = Math.max(...geometry.path.samples.map((sample, index, all) => index === 0 ? 0 : Math.abs(sample.position.z - all[index - 1].position.z) / Math.max(0.001, distance(sample.position, all[index - 1].position))), 0);
    if (maximumGrade > 0.25) issues.push(issue("elevation.grade-high", maximumGrade > 0.5 ? "error" : "warning", `Maximum grade is ${(maximumGrade * 100).toFixed(1)}%.`, ["primary"], undefined, "Reduce elevation delta or add a transition module."));
  }
  return { valid: !issues.some((item) => item.severity === "error"), issues, generatedAt: Date.now() };
}

export function diagnostics(document: TrackDocument) {
  const geometry = buildTrackGeometry(document);
  if (!geometry) return { lapLengthMeters: 0, elevationGainMeters: 0, maxCurvature: 0, minimumCornerRadiusMeters: 0, straightSections: 0, highSpeedSections: 0, lowSpeedSections: 0, brakingZones: 0, sectorLengths: [], pitLengthMeters: 0, racingLineMaxCurvature: 0, maxGrade: 0 };
  const straightSections = geometry.path.samples.filter((sample) => sample.curvature < 0.005).length;
  const sectorLengths = document.markers.filter((marker) => marker.type === "sector").sort((a, b) => a.location.distanceMeters - b.location.distanceMeters).map((marker, index, markers) => ({ id: marker.id, lengthMeters: (markers[index + 1]?.location.distanceMeters ?? geometry.path.totalLengthMeters) - marker.location.distanceMeters }));
  const pitPath = document.paths.find((path) => path.kind === "pit");
  const pitLengthMeters = pitPath ? buildPathGeometry(document, pitPath.id)?.path.totalLengthMeters ?? 0 : 0;
  const racingLine = document.paths.find((path) => path.kind === "racing-line");
  const racingLineMaxCurvature = racingLine ? Math.max(...(buildPathGeometry(document, racingLine.id)?.path.samples.map((sample) => sample.curvature) ?? [0])) : 0;
  const maxGrade = Math.max(...geometry.path.samples.map((sample, index, all) => index === 0 ? 0 : Math.abs(sample.position.z - all[index - 1].position.z) / Math.max(0.001, distance(sample.position, all[index - 1].position))), 0);
  const highSpeedSections = geometry.path.samples.filter((sample) => sample.curvature < 0.01).length;
  const lowSpeedSections = geometry.path.samples.filter((sample) => sample.curvature > 0.025).length;
  const brakingZones = geometry.path.samples.filter((sample, index, all) => index > 0 && sample.curvature - all[index - 1].curvature > 0.01).length;
  return {
    lapLengthMeters: geometry.path.totalLengthMeters,
    elevationGainMeters: geometry.path.samples.reduce((sum, sample, index, all) => index === 0 ? sum : sum + Math.max(0, sample.position.z - all[index - 1].position.z), 0),
    maxCurvature: Math.max(...geometry.path.samples.map((sample) => sample.curvature), 0),
    minimumCornerRadiusMeters: Math.min(...geometry.path.samples.map((sample) => sample.curvature > 0 ? 1 / sample.curvature : Number.POSITIVE_INFINITY).filter(Number.isFinite), Number.POSITIVE_INFINITY),
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
