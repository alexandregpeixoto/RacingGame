import type {
  ConnectorDefinition,
  ConnectorReference,
  ModuleGeometry,
  ParametricCurve,
  PathSample,
  SampledPath,
  TrackDocument,
  TrackGeometry,
  TrackModule,
  TrackProjection,
  PathControlPoint,
  TrackPath,
  Vec2,
  Vec3,
} from "./types";
import { add, angleDelta, boundsFromPoints, clamp, distance, lerp, lerpVec3, normalize, rotate, transformAngle, transformPoint } from "./math";
import { createModuleGeometry } from "./modules";

class ReversedCurve implements ParametricCurve {
  constructor(private readonly source: ParametricCurve) {}
  evaluate(t: number): Vec3 { return this.source.evaluate(1 - clamp(t, 0, 1)); }
  tangent(t: number): Vec3 { const tangent = this.source.tangent(1 - clamp(t, 0, 1)); return { x: -tangent.x, y: -tangent.y, z: -tangent.z }; }
  curvature(t: number): number { return this.source.curvature(1 - clamp(t, 0, 1)); }
  length(): number { return this.source.length(); }
}

interface OrientedModule {
  module: TrackModule;
  geometry: ModuleGeometry;
  reversed: boolean;
}

function connectorKey(reference: ConnectorReference): string {
  return `${reference.moduleId}:${reference.connectorId}`;
}

export function getWorldConnector(moduleItem: TrackModule, connectorId: ConnectorDefinition["id"]): ConnectorDefinition | undefined {
  const geometry = createModuleGeometry(moduleItem.definitionId, moduleItem.parameters);
  const connector = geometry?.connectors.find((item) => item.id === connectorId);
  if (!connector) return undefined;
  const worldPosition = transformPoint(connector.position, moduleItem.transform.position, moduleItem.transform.rotation);
  return {
    ...connector,
    position: worldPosition,
    tangent: transformAngle(connector.tangent, moduleItem.transform.rotation),
  };
}

export function getOpenConnectors(document: TrackDocument): Array<{ module: TrackModule; connector: ConnectorDefinition }> {
  const connected = new Set(document.connections.flatMap((connection) => [connectorKey(connection.a), connectorKey(connection.b)]));
  return document.modules.flatMap((moduleItem) => (["start", "end"] as const)
    .filter((connectorId) => !connected.has(`${moduleItem.id}:${connectorId}`))
    .map((connectorId) => ({ module: moduleItem, connector: getWorldConnector(moduleItem, connectorId)! })));
}

function connectionFor(document: TrackDocument, reference: ConnectorReference): ConnectorReference | undefined {
  const connection = document.connections.find((item) => connectorKey(item.a) === connectorKey(reference) || connectorKey(item.b) === connectorKey(reference));
  if (!connection) return undefined;
  return connectorKey(connection.a) === connectorKey(reference) ? connection.b : connection.a;
}

function traverseModules(document: TrackDocument): OrientedModule[] | undefined {
  if (document.modules.length === 0) return undefined;
  const first = document.modules[0];
  const firstEntry: ConnectorReference = { moduleId: first.id, connectorId: "start" };
  const visited = new Set<string>();
  const ordered: OrientedModule[] = [];
  let currentModule = first;
  let entry: ConnectorReference = firstEntry;

  for (let index = 0; index <= document.modules.length; index += 1) {
    if (visited.has(currentModule.id)) {
      return connectorKey(entry) === connectorKey(firstEntry) && ordered.length === document.modules.length ? ordered : undefined;
    }
    const geometry = createModuleGeometry(currentModule.definitionId, currentModule.parameters);
    if (!geometry) return undefined;
    visited.add(currentModule.id);
    const reversed = entry.connectorId === "end";
    ordered.push({ module: currentModule, geometry, reversed });
    const exit: ConnectorReference = { moduleId: currentModule.id, connectorId: reversed ? "start" : "end" };
    const next = connectionFor(document, exit);
    if (!next) return undefined;
    const nextModule = document.modules.find((item) => item.id === next.moduleId);
    if (!nextModule) return undefined;
    if (next.moduleId === first.id) {
      return next.connectorId === firstEntry.connectorId && ordered.length === document.modules.length ? ordered : undefined;
    }
    currentModule = nextModule;
    entry = next;
  }
  return undefined;
}

function createSampledPath(segments: OrientedModule[]): SampledPath {
  const samples: PathSample[] = [];
  let accumulated = 0;
  const countPerModule = 32;

  segments.forEach(({ module, geometry, reversed }) => {
    const curve = reversed ? new ReversedCurve(geometry.curve) : geometry.curve;
    for (let index = 0; index <= countPerModule; index += 1) {
      if (samples.length > 0 && index === 0) continue;
      const t = index / countPerModule;
      const localT = reversed ? 1 - t : t;
      const localPosition = curve.evaluate(t);
      const localTangent = curve.tangent(t);
      const position = transformPoint(localPosition, module.transform.position, module.transform.rotation);
      const tangent = transformPoint({ x: localTangent.x, y: localTangent.y, z: 0 }, { x: 0, y: 0, z: 0 }, module.transform.rotation);
      const planarTangent = normalize({ x: tangent.x, y: tangent.y });
      const previous = samples[samples.length - 1];
      if (previous) accumulated += distance(previous.position, position);
      samples.push({
        s: accumulated,
        position,
        tangent: { x: planarTangent.x, y: planarTangent.y, z: localTangent.z },
        curvature: curve.curvature(t),
        width: geometry.width,
        moduleId: module.id,
        localT,
      });
    }
  });

  const totalLengthMeters = accumulated;
  const leftBoundary: Vec3[] = [];
  const rightBoundary: Vec3[] = [];
  samples.forEach((sample) => {
    const normal = { x: -sample.tangent.y, y: sample.tangent.x };
    leftBoundary.push({ x: sample.position.x + normal.x * sample.width / 2, y: sample.position.y + normal.y * sample.width / 2, z: sample.position.z });
    rightBoundary.push({ x: sample.position.x - normal.x * sample.width / 2, y: sample.position.y - normal.y * sample.width / 2, z: sample.position.z });
  });

  const sampleAtDistance = (distanceMeters: number): PathSample => {
    const target = wrapDistance(distanceMeters);
    let low = 0;
    let high = samples.length - 1;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (samples[middle].s < target) low = middle + 1;
      else high = middle;
    }
    const upperIndex = Math.min(samples.length - 1, Math.max(1, low));
    const lower = samples[upperIndex - 1];
    const upper = samples[upperIndex];
    const span = upper.s - lower.s || 1;
    const t = clamp((target - lower.s) / span, 0, 1);
    return {
      ...lower,
      s: target,
      position: lerpVec3(lower.position, upper.position, t),
      tangent: { ...normalize({ x: lower.tangent.x + (upper.tangent.x - lower.tangent.x) * t, y: lower.tangent.y + (upper.tangent.y - lower.tangent.y) * t }), z: lower.tangent.z + (upper.tangent.z - lower.tangent.z) * t },
      curvature: lower.curvature + (upper.curvature - lower.curvature) * t,
    };
  };

  const wrapDistance = (value: number): number => {
    if (totalLengthMeters <= 0) return 0;
    return ((value % totalLengthMeters) + totalLengthMeters) % totalLengthMeters;
  };

  const positionAtDistance = (value: number) => sampleAtDistance(value).position;
  const tangentAtDistance = (value: number) => sampleAtDistance(value).tangent;
  const nearestPoint = (position: Vec2): TrackProjection => {
    let nearest: TrackProjection = { distanceMeters: 0, position: samples[0]?.position ?? { x: 0, y: 0, z: 0 }, distanceToTrack: Number.POSITIVE_INFINITY };
    samples.forEach((sample) => {
      const currentDistance = distance(position, sample.position);
      if (currentDistance < nearest.distanceToTrack) nearest = { distanceMeters: sample.s, position: sample.position, distanceToTrack: currentDistance, moduleId: sample.moduleId };
    });
    return nearest;
  };

  return { totalLengthMeters, samples, leftBoundary, rightBoundary, positionAtDistance, tangentAtDistance, sampleAtDistance, nearestPoint, wrapDistance };
}

export function buildPrimaryPath(document: TrackDocument): SampledPath | undefined {
  const segments = traverseModules(document);
  return segments ? createSampledPath(segments) : undefined;
}

export function buildTrackGeometry(document: TrackDocument): TrackGeometry | undefined {
  const path = buildPrimaryPath(document);
  if (!path) return undefined;
  const points = [...path.leftBoundary, ...path.rightBoundary].map(({ x, y }) => ({ x, y }));
  return { path, bounds: boundsFromPoints(points) };
}

export class CubicBezierCurve implements ParametricCurve {
  constructor(private readonly p0: Vec3, private readonly p1: Vec3, private readonly p2: Vec3, private readonly p3: Vec3) {}
  evaluate(t: number): Vec3 {
    const u = 1 - clamp(t, 0, 1);
    const value = clamp(t, 0, 1);
    return {
      x: u ** 3 * this.p0.x + 3 * u ** 2 * value * this.p1.x + 3 * u * value ** 2 * this.p2.x + value ** 3 * this.p3.x,
      y: u ** 3 * this.p0.y + 3 * u ** 2 * value * this.p1.y + 3 * u * value ** 2 * this.p2.y + value ** 3 * this.p3.y,
      z: u ** 3 * this.p0.z + 3 * u ** 2 * value * this.p1.z + 3 * u * value ** 2 * this.p2.z + value ** 3 * this.p3.z,
    };
  }
  tangent(t: number): Vec3 {
    const value = clamp(t, 0, 1);
    const u = 1 - value;
    const dx = 3 * u ** 2 * (this.p1.x - this.p0.x) + 6 * u * value * (this.p2.x - this.p1.x) + 3 * value ** 2 * (this.p3.x - this.p2.x);
    const dy = 3 * u ** 2 * (this.p1.y - this.p0.y) + 6 * u * value * (this.p2.y - this.p1.y) + 3 * value ** 2 * (this.p3.y - this.p2.y);
    const dz = 3 * u ** 2 * (this.p1.z - this.p0.z) + 6 * u * value * (this.p2.z - this.p1.z) + 3 * value ** 2 * (this.p3.z - this.p2.z);
    const planar = normalize({ x: dx, y: dy });
    return { x: planar.x, y: planar.y, z: dz / Math.max(0.001, Math.hypot(dx, dy, dz)) };
  }
  curvature(t: number): number {
    const first = this.tangent(t);
    const next = this.tangent(clamp(t + 0.01, 0, 1));
    return Math.abs(angleDelta(Math.atan2(next.y, next.x), Math.atan2(first.y, first.x))) / 0.01;
  }
  length(): number {
    let total = 0;
    let previous = this.p0;
    for (let index = 1; index <= 32; index += 1) {
      const current = this.evaluate(index / 32);
      total += distance(previous, current);
      previous = current;
    }
    return total;
  }
}

function sampleCurvePath(curves: Array<{ curve: ParametricCurve; pathId: string; localStart: number; localEnd: number }>, width: number, closed: boolean): SampledPath {
  const samples: PathSample[] = [];
  let accumulated = 0;
  curves.forEach(({ curve, pathId, localStart, localEnd }) => {
    for (let index = 0; index <= 32; index += 1) {
      if (samples.length > 0 && index === 0) continue;
      const t = index / 32;
      const position = curve.evaluate(t);
      const tangent = curve.tangent(t);
      const previous = samples[samples.length - 1];
      if (previous) accumulated += distance(previous.position, position);
      const planar = normalize({ x: tangent.x, y: tangent.y });
      samples.push({ s: accumulated, position, tangent: { x: planar.x, y: planar.y, z: tangent.z }, curvature: curve.curvature(t), width, moduleId: pathId, localT: localStart + (localEnd - localStart) * t });
    }
  });
  if (closed && samples.length > 1) accumulated += distance(samples[samples.length - 1].position, samples[0].position);
  const totalLengthMeters = accumulated;
  const leftBoundary: Vec3[] = [];
  const rightBoundary: Vec3[] = [];
  samples.forEach((sample) => {
    const normal = { x: -sample.tangent.y, y: sample.tangent.x };
    leftBoundary.push({ x: sample.position.x + normal.x * width / 2, y: sample.position.y + normal.y * width / 2, z: sample.position.z });
    rightBoundary.push({ x: sample.position.x - normal.x * width / 2, y: sample.position.y - normal.y * width / 2, z: sample.position.z });
  });
  const wrapDistance = (value: number) => closed && totalLengthMeters > 0 ? ((value % totalLengthMeters) + totalLengthMeters) % totalLengthMeters : clamp(value, 0, totalLengthMeters);
  const sampleAtDistance = (value: number): PathSample => {
    const target = wrapDistance(value);
    if (samples.length === 0) return { s: 0, position: { x: 0, y: 0, z: 0 }, tangent: { x: 1, y: 0, z: 0 }, curvature: 0, width, moduleId: "", localT: 0 };
    if (target <= samples[0].s) return { ...samples[0], s: target };
    const last = samples[samples.length - 1];
    if (target >= last.s) return { ...last, s: target };
    let upperIndex = 1;
    while (upperIndex < samples.length && samples[upperIndex].s < target) upperIndex += 1;
    const lower = samples[upperIndex - 1];
    const upper = samples[upperIndex];
    const t = clamp((target - lower.s) / Math.max(0.001, upper.s - lower.s), 0, 1);
    return { ...lower, s: target, position: lerpVec3(lower.position, upper.position, t), tangent: { ...normalize({ x: lower.tangent.x + (upper.tangent.x - lower.tangent.x) * t, y: lower.tangent.y + (upper.tangent.y - lower.tangent.y) * t }), z: lower.tangent.z + (upper.tangent.z - lower.tangent.z) * t }, curvature: lerp(lower.curvature, upper.curvature, t) };
  };
  const nearestPoint = (position: Vec2): TrackProjection => {
    let nearest: TrackProjection = { distanceMeters: 0, position: samples[0]?.position ?? { x: 0, y: 0, z: 0 }, distanceToTrack: Number.POSITIVE_INFINITY };
    samples.forEach((sample) => { const currentDistance = distance(position, sample.position); if (currentDistance < nearest.distanceToTrack) nearest = { distanceMeters: sample.s, position: sample.position, distanceToTrack: currentDistance, moduleId: sample.moduleId }; });
    return nearest;
  };
  return { totalLengthMeters, samples, leftBoundary, rightBoundary, positionAtDistance: (value) => sampleAtDistance(value).position, tangentAtDistance: (value) => sampleAtDistance(value).tangent, sampleAtDistance, nearestPoint, wrapDistance };
}

export function buildControlPointPath(path: TrackPath): SampledPath | undefined {
  const points = path.controlPoints ?? [];
  if (points.length < 2) return undefined;
  const curves: Array<{ curve: ParametricCurve; pathId: string; localStart: number; localEnd: number }> = [];
  const segmentCount = path.closed ? points.length : points.length - 1;
  for (let index = 0; index < segmentCount; index += 1) {
    const start = points[index];
    const end = points[(index + 1) % points.length];
    curves.push({ curve: new CubicBezierCurve(start.position, { x: start.position.x + start.outHandle.x, y: start.position.y + start.outHandle.y, z: start.position.z }, { x: end.position.x + end.inHandle.x, y: end.position.y + end.inHandle.y, z: end.position.z }, end.position), pathId: path.id, localStart: index / segmentCount, localEnd: (index + 1) / segmentCount });
  }
  return sampleCurvePath(curves, path.widthMeters ?? (path.kind === "pit" ? 6 : 1), path.closed);
}

export function buildPathGeometry(document: TrackDocument, pathId: string): TrackGeometry | undefined {
  if (pathId === "primary") return buildTrackGeometry(document);
  const path = document.paths.find((item) => item.id === pathId);
  const sampled = path ? buildControlPointPath(path) : undefined;
  if (!sampled) return undefined;
  const points = [...sampled.leftBoundary, ...sampled.rightBoundary].map(({ x, y }) => ({ x, y }));
  return { path: sampled, bounds: boundsFromPoints(points) };
}

export function buildAllPathGeometries(document: TrackDocument): Record<string, TrackGeometry> {
  return document.paths.reduce<Record<string, TrackGeometry>>((result, path) => {
    const geometry = buildPathGeometry(document, path.id);
    if (geometry) result[path.id] = geometry;
    return result;
  }, {});
}

export function getModuleWorldBounds(module: TrackModule): { min: Vec2; max: Vec2 } {
  const geometry = createModuleGeometry(module.definitionId, module.parameters);
  if (!geometry) return { min: { x: 0, y: 0 }, max: { x: 0, y: 0 } };
  const points = Array.from({ length: 33 }, (_, index) => transformPoint(geometry.curve.evaluate(index / 32), module.transform.position, module.transform.rotation));
  return boundsFromPoints(points.map(({ x, y }) => ({ x, y })));
}

export function moduleContainsPoint(module: TrackModule, point: Vec2, tolerance = 3): boolean {
  const geometry = createModuleGeometry(module.definitionId, module.parameters);
  if (!geometry) return false;
  const local = rotate({ x: point.x - module.transform.position.x, y: point.y - module.transform.position.y }, -module.transform.rotation);
  let closest = Number.POSITIVE_INFINITY;
  for (let index = 0; index <= 32; index += 1) {
    const sample = geometry.curve.evaluate(index / 32);
    closest = Math.min(closest, distance(local, sample));
  }
  return closest <= geometry.width / 2 + tolerance;
}

export function snapModuleToOpenConnector(document: TrackDocument, module: TrackModule, snapDistance: number): { module: TrackModule; connection?: { a: ConnectorReference; b: ConnectorReference } } {
  const candidateStart = getWorldConnector(module, "start");
  if (!candidateStart) return { module };
  const open = getOpenConnectors(document);
  let best: { target: { module: TrackModule; connector: ConnectorDefinition }; distance: number } | undefined;
  open.forEach((target) => {
    const currentDistance = distance(candidateStart.position, target.connector.position);
    if (currentDistance <= snapDistance && Math.abs(candidateStart.width - target.connector.width) <= 2 && (!best || currentDistance < best.distance)) best = { target, distance: currentDistance };
  });
  if (!best) return { module };
  const rotation = best.target.connector.tangent + Math.PI - (createModuleGeometry(module.definitionId, module.parameters)?.connectors.find((item) => item.id === "start")?.tangent ?? Math.PI);
  const localStart = createModuleGeometry(module.definitionId, module.parameters)?.connectors.find((item) => item.id === "start")?.position ?? { x: 0, y: 0, z: 0 };
  const rotatedStart = rotate(localStart, rotation);
  const nextModule: TrackModule = { ...module, transform: { ...module.transform, rotation, position: { x: best.target.connector.position.x - rotatedStart.x, y: best.target.connector.position.y - rotatedStart.y, z: module.transform.position.z } } };
  return { module: nextModule, connection: { a: { moduleId: best.target.module.id, connectorId: best.target.connector.id }, b: { moduleId: module.id, connectorId: "start" } } };
}
