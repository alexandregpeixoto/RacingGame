import type {
  ConnectorDefinition,
  ConnectorReference,
  ParametricCurve,
  TrackPath,
  PathSample,
  SampledPath,
  TrackDocument,
  TrackGeometry,
  TrackModule,
  TrackProjection,
  Vec2,
  Vec3,
} from "./types";
import {
  angleDelta,
  boundsFromPoints,
  clamp,
  distance,
  lerp,
  lerpVec3,
  normalize,
  pointInPolygon,
  rotate,
  transformPoint,
} from "./math";
import { createModuleGeometry } from "./modules";

export const CONNECTION_TOLERANCE = 0.05;
const key = (reference: ConnectorReference) =>
  reference.moduleId + ":" + reference.connectorId;
export function effectiveModule(
  document: TrackDocument,
  module: TrackModule,
): TrackModule {
  const properties = Object.assign(
    {},
    module.properties,
    ...document.overrides
      .filter((item) => item.targetId === module.id)
      .map((item) => item.values),
  );
  return {
    ...module,
    properties,
    parameters: {
      ...module.parameters,
      ...Object.fromEntries(
        [
          "endWidth",
          "branchWidth",
          "leftStart",
          "leftEnd",
          "rightStart",
          "rightEnd",
        ]
          .filter(
            (k) =>
              module.parameters[k] !== undefined &&
              properties.widthMeters !== undefined,
          )
          .map((k) => [
            k,
            (module.parameters[k] * properties.widthMeters!) /
              (module.parameters.width ?? 10),
          ]),
      ),
      width: properties.widthMeters ?? module.parameters.width ?? 10,
    },
  };
}
export function getWorldConnector(
  module: TrackModule,
  connectorId: ConnectorDefinition["id"],
): ConnectorDefinition | undefined {
  const connector = createModuleGeometry(
    module.definitionId,
    {
      ...module.parameters,
      width: module.properties?.widthMeters ?? module.parameters.width,
    },
    module.controlPoints,
  )?.connectors.find((item) => item.id === connectorId);
  return connector
    ? {
        ...connector,
        position: transformPoint(
          connector.position,
          module.transform.position,
          module.transform.rotation,
        ),
        tangent: connector.tangent + module.transform.rotation,
      }
    : undefined;
}
export function connectorsCompatible(
  a: ConnectorDefinition,
  b: ConnectorDefinition,
  tolerance = CONNECTION_TOLERANCE,
): boolean {
  return (
    a.type === b.type &&
    Math.abs(a.width - b.width) <= 0.01 &&
    Math.abs((a.leftWidth ?? a.width / 2) - (b.rightWidth ?? b.width / 2)) <=
      0.01 &&
    Math.abs((a.rightWidth ?? a.width / 2) - (b.leftWidth ?? b.width / 2)) <=
      0.01 &&
    distance(a.position, b.position) <= tolerance &&
    Math.abs(a.position.z - b.position.z) <= CONNECTION_TOLERANCE &&
    Math.abs(Math.abs(angleDelta(a.tangent, b.tangent)) - Math.PI) < 0.001
  );
}
export function getOpenConnectors(
  document: TrackDocument,
  pathId?: string,
): Array<{ module: TrackModule; connector: ConnectorDefinition }> {
  const occupied = new Set(
    document.connections.flatMap((item) => [key(item.a), key(item.b)]),
  );
  const members = pathId
    ? new Set(
        document.paths.find((path) => path.id === pathId)?.sourceModuleIds ??
          [],
      )
    : undefined;
  return document.modules
    .filter((module) => !members || members.has(module.id))
    .flatMap((source) => {
      const module = effectiveModule(document, source);
      return (
        createModuleGeometry(
          module.definitionId,
          module.parameters,
          module.controlPoints,
        )?.connectors ?? []
      ).flatMap(({ id }) => {
        const connector = getWorldConnector(module, id);
        return connector &&
          !occupied.has(key({ moduleId: module.id, connectorId: id }))
          ? [{ module, connector }]
          : [];
      });
    });
}
export function connectMatchingConnectors(
  document: TrackDocument,
  pathId?: string,
): TrackDocument {
  const next = structuredClone(document),
    open = getOpenConnectors(next, pathId),
    used = new Set<string>();
  open.forEach((a, i) => {
    const aRef = { moduleId: a.module.id, connectorId: a.connector.id };
    if (used.has(key(aRef))) return;
    const b = open
      .slice(i + 1)
      .find(
        (item) =>
          item.module.id !== a.module.id &&
          (document.schemaVersion >= 2 ||
            modulePathId(document, item.module.id) ===
              modulePathId(document, a.module.id)) &&
          !used.has(
            key({ moduleId: item.module.id, connectorId: item.connector.id }),
          ) &&
          connectorsCompatible(a.connector, item.connector),
      );
    if (!b) return;
    const bRef = { moduleId: b.module.id, connectorId: b.connector.id };
    next.connections.push({
      id: "connection-" + crypto.randomUUID(),
      a: aRef,
      b: bRef,
    });
    used.add(key(aRef));
    used.add(key(bRef));
  });
  return next;
}
interface Segment {
  module: TrackModule;
  reversed: boolean;
  traversalId?: string;
}
export function modulePathId(
  document: TrackDocument,
  moduleId: string,
): string | undefined {
  return document.paths.find((path) => path.sourceModuleIds.includes(moduleId))
    ?.id;
}
function traverseModules(
  document: TrackDocument,
  path: TrackPath,
): Segment[] | undefined {
  if (path.traversals) {
    if (!path.traversals.length) return;
    const segments: Segment[] = [];
    const ends: { entry: ConnectorReference; exit: ConnectorReference }[] = [];
    for (const step of path.traversals) {
      const source = document.modules.find((item) => item.id === step.moduleId);
      if (!source) return;
      const module = effectiveModule(document, source);
      const traversal = createModuleGeometry(
        module.definitionId,
        module.parameters,
        module.controlPoints,
      )?.traversals?.find((item) => item.id === step.traversalId);
      if (!traversal) return;
      segments.push({
        module,
        reversed: step.reversed,
        traversalId: step.traversalId,
      });
      ends.push({
        entry: {
          moduleId: module.id,
          connectorId: step.reversed ? traversal.exit : traversal.entry,
        },
        exit: {
          moduleId: module.id,
          connectorId: step.reversed ? traversal.entry : traversal.exit,
        },
      });
    }
    for (let i = 0; i < ends.length - (path.closed ? 0 : 1); i++) {
      const a = ends[i].exit,
        b = ends[(i + 1) % ends.length].entry;
      const connection = document.connections.find(
        (c) =>
          (key(c.a) === key(a) && key(c.b) === key(b)) ||
          (key(c.b) === key(a) && key(c.a) === key(b)),
      );
      if (
        !connection ||
        !connectorsCompatible(
          getWorldConnector(segments[i].module, a.connectorId)!,
          getWorldConnector(
            segments[(i + 1) % ends.length].module,
            b.connectorId,
          )!,
        )
      )
        return;
    }
    return segments;
  }
  const ids = path.sourceModuleIds;
  if (!ids.length || new Set(ids).size !== ids.length) return;
  const members = new Set(ids);
  const modules = new Map(
    document.modules
      .filter((module) => members.has(module.id))
      .map((module) => [module.id, effectiveModule(document, module)]),
  );
  if (modules.size !== ids.length) return;
  const graph = new Map<string, ConnectorReference>();
  for (const connection of document.connections) {
    const a = modules.get(connection.a.moduleId),
      b = modules.get(connection.b.moduleId);
    if (!a && !b) continue;
    if (
      document.schemaVersion >= 2 &&
      (!["start", "end"].includes(connection.a.connectorId) ||
        !["start", "end"].includes(connection.b.connectorId))
    )
      continue;
    const ac = a && getWorldConnector(a, connection.a.connectorId),
      bc = b && getWorldConnector(b, connection.b.connectorId);
    if (
      !ac ||
      !bc ||
      key(connection.a) === key(connection.b) ||
      graph.has(key(connection.a)) ||
      graph.has(key(connection.b)) ||
      !connectorsCompatible(ac, bc)
    )
      return;
    graph.set(key(connection.a), connection.b);
    graph.set(key(connection.b), connection.a);
  }
  let first: ConnectorReference = { moduleId: ids[0], connectorId: "start" };
  if (!path.closed) {
    const open = ids
      .flatMap((moduleId) =>
        (["start", "end"] as const).map((connectorId) => ({
          moduleId,
          connectorId,
        })),
      )
      .filter((ref) => !graph.has(key(ref)));
    if (open.length !== 2) return;
    const entry = document.markers.find(
      (marker) =>
        marker.id === path.entryMarkerId ||
        (!path.entryMarkerId && marker.type === "pit-entry"),
    );
    const primary =
      entry &&
      document.paths.find(
        (item) =>
          item.id === entry.location.pathId && item.kind === "primary-loop",
      );
    const entryGeometry = primary && buildTrackGeometry(document);
    const point = entryGeometry?.path.positionAtDistance(
      entry!.location.distanceMeters,
    );
    first = point
      ? open.sort(
          (a, b) =>
            distance(
              getWorldConnector(modules.get(a.moduleId)!, a.connectorId)!
                .position,
              point,
            ) -
            distance(
              getWorldConnector(modules.get(b.moduleId)!, b.connectorId)!
                .position,
              point,
            ),
        )[0]
      : (open.find((ref) => ref.connectorId === "start") ?? open[0]);
  }
  let entry = first;
  const visited = new Set<string>(),
    segments: Segment[] = [];
  while (!visited.has(entry.moduleId)) {
    const module = modules.get(entry.moduleId);
    if (!module) return;
    visited.add(module.id);
    const reversed = entry.connectorId === "end";
    segments.push({ module, reversed });
    const exit: ConnectorReference = {
      moduleId: module.id,
      connectorId: reversed ? "start" : "end",
    };
    const next = graph.get(key(exit));
    if (!next)
      return !path.closed && visited.size === ids.length ? segments : undefined;
    entry = next;
  }
  return path.closed && key(entry) === key(first) && visited.size === ids.length
    ? segments
    : undefined;
}
export function projectSamples(
  samples: PathSample[],
  point: Vec2,
): TrackProjection {
  let nearest: TrackProjection = {
    distanceMeters: 0,
    position: samples[0].position,
    distanceToTrack: Infinity,
  };
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1],
      b = samples[i];
    const dx = b.position.x - a.position.x,
      dy = b.position.y - a.position.y,
      lengthSquared = dx * dx + dy * dy;
    if (lengthSquared < 1e-18) continue;
    const t = clamp(
      ((point.x - a.position.x) * dx + (point.y - a.position.y) * dy) /
        lengthSquared,
      0,
      1,
    );
    const position = lerpVec3(a.position, b.position, t),
      separation = distance(point, position);
    if (separation < nearest.distanceToTrack)
      nearest = {
        position,
        distanceToTrack: separation,
        distanceMeters: lerp(a.s, b.s, t),
        moduleId: a.moduleId,
        traversalId: a.traversalId,
        localT: lerp(a.localT, b.localT, t),
      };
  }
  return nearest;
}
export function sampledPath(
  samples: PathSample[],
  closed: boolean,
): SampledPath {
  const totalLengthMeters = samples.at(-1)!.s,
    leftBoundary: Vec3[] = [],
    rightBoundary: Vec3[] = [];
  samples.forEach((sample) => {
    const tangent = normalize(sample.tangent);
    leftBoundary.push({
      x: sample.position.x - tangent.y * (sample.leftWidth ?? sample.width / 2),
      y: sample.position.y + tangent.x * (sample.leftWidth ?? sample.width / 2),
      z: sample.position.z,
    });
    rightBoundary.push({
      x:
        sample.position.x + tangent.y * (sample.rightWidth ?? sample.width / 2),
      y:
        sample.position.y - tangent.x * (sample.rightWidth ?? sample.width / 2),
      z: sample.position.z,
    });
  });
  const drivablePolygons = samples
    .slice(1)
    .flatMap((sample, index) =>
      sample.s > samples[index].s + 1e-9
        ? [
            [
              leftBoundary[index],
              leftBoundary[index + 1],
              rightBoundary[index + 1],
              rightBoundary[index],
            ],
          ]
        : [],
    );
  const wrapDistance = (value: number) =>
    closed && totalLengthMeters > 0
      ? ((value % totalLengthMeters) + totalLengthMeters) % totalLengthMeters
      : clamp(value, 0, totalLengthMeters);
  const sampleAtDistance = (value: number): PathSample => {
    const target = wrapDistance(value);
    let low = 0,
      high = samples.length - 1;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (samples[mid].s <= target) low = mid + 1;
      else high = mid;
    }
    const upper = samples[low],
      lower = samples[Math.max(0, low - 1)],
      t = clamp((target - lower.s) / (upper.s - lower.s || 1), 0, 1);
    const tangent = lerpVec3(lower.tangent, upper.tangent, t),
      magnitude = Math.hypot(tangent.x, tangent.y, tangent.z) || 1;
    return {
      ...lower,
      s: target,
      position: lerpVec3(lower.position, upper.position, t),
      tangent: {
        x: tangent.x / magnitude,
        y: tangent.y / magnitude,
        z: tangent.z / magnitude,
      },
      curvature: lerp(lower.curvature, upper.curvature, t),
      width: lerp(lower.width, upper.width, t),
      leftWidth: lerp(
        lower.leftWidth ?? lower.width / 2,
        upper.leftWidth ?? upper.width / 2,
        t,
      ),
      rightWidth: lerp(
        lower.rightWidth ?? lower.width / 2,
        upper.rightWidth ?? upper.width / 2,
        t,
      ),
      localT: lerp(lower.localT, upper.localT, t),
    };
  };
  return {
    closed,
    totalLengthMeters,
    samples,
    leftBoundary,
    rightBoundary,
    drivablePolygons,
    wrapDistance,
    sampleAtDistance,
    positionAtDistance: (value) => sampleAtDistance(value).position,
    tangentAtDistance: (value) => sampleAtDistance(value).tangent,
    nearestPoint: (point) => projectSamples(samples, point),
  };
}
function sampleModules(segments: Segment[], closed: boolean): SampledPath {
  const samples: PathSample[] = [];
  let accumulated = 0;
  for (const { module, reversed, traversalId = "main" } of segments) {
    const geometry = createModuleGeometry(
      module.definitionId,
      {
        ...module.parameters,
        width: module.properties?.widthMeters ?? module.parameters.width,
      },
      module.controlPoints,
    )!;
    const traversal = geometry.traversals!.find(
      (item) => item.id === traversalId,
    )!;
    const curve = traversal.curve;
    const count = Math.min(
      2048,
      Math.max(32, Math.ceil(curve.length() / 0.75)),
    );
    for (let i = 0; i <= count; i++) {
      const t = i / count,
        localT = reversed ? 1 - t : t;
      const position = transformPoint(
        curve.evaluate(localT),
        module.transform.position,
        module.transform.rotation,
      );
      const widths = traversal.widthAt(localT);
      const source = curve.tangent(localT),
        planar = rotate(source, module.transform.rotation),
        sign = reversed ? -1 : 1;
      samples.push({
        s: accumulated + curve.length() * t,
        position,
        tangent: { x: planar.x * sign, y: planar.y * sign, z: source.z * sign },
        curvature: curve.curvature(localT),
        width: widths.left + widths.right,
        leftWidth: reversed ? widths.right : widths.left,
        rightWidth: reversed ? widths.left : widths.right,
        traversalId,
        moduleId: module.id,
        localT,
      });
    }
    accumulated += curve.length();
  }
  return sampledPath(samples, closed);
}
export function buildModulePath(
  module: TrackModule,
  traversalId = "main",
): SampledPath {
  return sampleModules([{ module, reversed: false, traversalId }], false);
}
export function buildModulePaths(module: TrackModule): SampledPath[] {
  return (
    createModuleGeometry(
      module.definitionId,
      module.parameters,
      module.controlPoints,
    )?.traversals ?? []
  ).map((route) => buildModulePath(module, route.id));
}
export function inferRouteTraversals(document: TrackDocument, path: TrackPath) {
  return traverseModules(document, path)?.map(
    ({ module, reversed, traversalId }) => ({
      moduleId: module.id,
      reversed,
      traversalId: traversalId ?? "main",
    }),
  );
}
export function buildPrimaryPath(
  document: TrackDocument,
): SampledPath | undefined {
  const primary = document.paths.filter((path) => path.kind === "primary-loop");
  if (primary.length !== 1 || !primary[0].closed) return;
  const segments = traverseModules(document, primary[0]);
  return segments && sampleModules(segments, true);
}
function geometryFor(path: SampledPath): TrackGeometry {
  return {
    path,
    bounds: boundsFromPoints([...path.leftBoundary, ...path.rightBoundary]),
  };
}
export function buildTrackGeometry(
  document: TrackDocument,
): TrackGeometry | undefined {
  const path = buildPrimaryPath(document);
  return path && geometryFor(path);
}
export class CubicBezierCurve implements ParametricCurve {
  constructor(
    private readonly p0: Vec3,
    private readonly p1: Vec3,
    private readonly p2: Vec3,
    private readonly p3: Vec3,
  ) {}
  evaluate(t: number): Vec3 {
    const u = 1 - clamp(t, 0, 1);
    const value = clamp(t, 0, 1);
    return {
      x:
        u ** 3 * this.p0.x +
        3 * u ** 2 * value * this.p1.x +
        3 * u * value ** 2 * this.p2.x +
        value ** 3 * this.p3.x,
      y:
        u ** 3 * this.p0.y +
        3 * u ** 2 * value * this.p1.y +
        3 * u * value ** 2 * this.p2.y +
        value ** 3 * this.p3.y,
      z:
        u ** 3 * this.p0.z +
        3 * u ** 2 * value * this.p1.z +
        3 * u * value ** 2 * this.p2.z +
        value ** 3 * this.p3.z,
    };
  }
  tangent(t: number): Vec3 {
    const value = clamp(t, 0, 1);
    const u = 1 - value;
    const dx =
      3 * u ** 2 * (this.p1.x - this.p0.x) +
      6 * u * value * (this.p2.x - this.p1.x) +
      3 * value ** 2 * (this.p3.x - this.p2.x);
    const dy =
      3 * u ** 2 * (this.p1.y - this.p0.y) +
      6 * u * value * (this.p2.y - this.p1.y) +
      3 * value ** 2 * (this.p3.y - this.p2.y);
    const dz =
      3 * u ** 2 * (this.p1.z - this.p0.z) +
      6 * u * value * (this.p2.z - this.p1.z) +
      3 * value ** 2 * (this.p3.z - this.p2.z);
    const magnitude = Math.hypot(dx, dy, dz);
    if (magnitude < 1e-9 && (t === 0 || t === 1))
      return this.tangent(clamp(t, 0.00001, 0.99999));
    return {
      x: dx / (magnitude || 1),
      y: dy / (magnitude || 1),
      z: dz / (magnitude || 1),
    };
  }
  curvature(t: number): number {
    const u = clamp(t, 0.0001, 0.9999),
      h = 0.00001;
    const before = this.evaluate(u - h),
      at = this.evaluate(u),
      after = this.evaluate(u + h);
    const a = {
      x: (after.x - before.x) / (2 * h),
      y: (after.y - before.y) / (2 * h),
      z: (after.z - before.z) / (2 * h),
    };
    const b = {
      x: (after.x - 2 * at.x + before.x) / (h * h),
      y: (after.y - 2 * at.y + before.y) / (h * h),
      z: (after.z - 2 * at.z + before.z) / (h * h),
    };
    return (
      Math.hypot(
        a.y * b.z - a.z * b.y,
        a.z * b.x - a.x * b.z,
        a.x * b.y - a.y * b.x,
      ) / Math.max(1e-18, Math.hypot(a.x, a.y, a.z) ** 3)
    );
  }
  length(): number {
    let total = 0;
    let previous = this.p0;
    for (let index = 1; index <= 32; index += 1) {
      const current = this.evaluate(index / 32);
      total += Math.hypot(
        previous.x - current.x,
        previous.y - current.y,
        previous.z - current.z,
      );
      previous = current;
    }
    return total;
  }
}

function sampleCurvePath(
  curves: Array<{
    curve: ParametricCurve;
    pathId: string;
    localStart: number;
    localEnd: number;
  }>,
  width: number,
  closed: boolean,
): SampledPath {
  const samples: PathSample[] = [];
  let accumulated = 0;
  curves.forEach(({ curve, pathId, localStart, localEnd }) => {
    const count = Math.min(2048, Math.max(32, Math.ceil(curve.length() / 1.5)));
    for (let index = 0; index <= count; index += 1) {
      if (samples.length > 0 && index === 0) continue;
      const t = index / count;
      const position = curve.evaluate(t);
      const tangent = curve.tangent(t);
      const previous = samples[samples.length - 1];
      if (previous)
        accumulated += Math.hypot(
          previous.position.x - position.x,
          previous.position.y - position.y,
          previous.position.z - position.z,
        );
      const planar = normalize({ x: tangent.x, y: tangent.y });
      samples.push({
        s: accumulated,
        position,
        tangent,
        curvature: curve.curvature(t),
        width,
        moduleId: pathId,
        localT: localStart + (localEnd - localStart) * t,
      });
    }
  });
  return sampledPath(samples, closed);
}

export function buildControlPointPath(
  path: TrackPath,
): SampledPath | undefined {
  const points = path.controlPoints ?? [];
  if (points.length < 2) return undefined;
  const curves: Array<{
    curve: ParametricCurve;
    pathId: string;
    localStart: number;
    localEnd: number;
  }> = [];
  const segmentCount = path.closed ? points.length : points.length - 1;
  for (let index = 0; index < segmentCount; index += 1) {
    const start = points[index];
    const end = points[(index + 1) % points.length];
    curves.push({
      curve: new CubicBezierCurve(
        start.position,
        {
          x: start.position.x + start.outHandle.x,
          y: start.position.y + start.outHandle.y,
          z: start.position.z,
        },
        {
          x: end.position.x + end.inHandle.x,
          y: end.position.y + end.inHandle.y,
          z: end.position.z,
        },
        end.position,
      ),
      pathId: path.id,
      localStart: index / segmentCount,
      localEnd: (index + 1) / segmentCount,
    });
  }
  return sampleCurvePath(
    curves,
    path.widthMeters ?? (path.kind === "pit" ? 6 : 1),
    path.closed,
  );
}

export function buildPathGeometry(
  document: TrackDocument,
  pathId: string,
): TrackGeometry | undefined {
  const path = document.paths.find((item) => item.id === pathId);
  if (path?.kind === "primary-loop") return buildTrackGeometry(document);
  const segments = path?.sourceModuleIds.length
    ? traverseModules(document, path)
    : undefined;
  const sampled = path?.sourceModuleIds.length
    ? segments && sampleModules(segments, path.closed)
    : path
      ? buildControlPointPath(path)
      : undefined;
  if (!sampled) return undefined;
  const points = [...sampled.leftBoundary, ...sampled.rightBoundary].map(
    ({ x, y }) => ({ x, y }),
  );
  return { path: sampled, bounds: boundsFromPoints(points) };
}

export function buildAllPathGeometries(
  document: TrackDocument,
): Record<string, TrackGeometry> {
  return document.paths.reduce<Record<string, TrackGeometry>>(
    (result, path) => {
      const geometry = buildPathGeometry(document, path.id);
      if (geometry) result[path.id] = geometry;
      return result;
    },
    Object.create(null),
  );
}

export function getModuleWorldBounds(module: TrackModule) {
  return boundsFromPoints(
    buildModulePaths(module).flatMap((path) => [
      ...path.leftBoundary,
      ...path.rightBoundary,
    ]),
  );
}
export function isPointDrivable(path: SampledPath, point: Vec2): boolean {
  return (
    path.drivablePolygons.some((polygon) => pointInPolygon(point, polygon)) ||
    path.nearestPoint(point).distanceToTrack < 1e-6
  );
}
export function moduleContainsPoint(
  module: TrackModule,
  point: Vec2,
  tolerance = 3,
): boolean {
  return buildModulePaths(module).some(
    (path) =>
      isPointDrivable(path, point) ||
      path.nearestPoint(point).distanceToTrack <= tolerance,
  );
}
export function snapModuleToOpenConnector(
  document: TrackDocument,
  module: TrackModule,
  snapDistance: number,
  pathId = modulePathId(document, module.id) ??
    document.paths.find((path) => path.kind === "primary-loop")?.id,
  connectorId = "start",
): {
  module: TrackModule;
  connection?: { a: ConnectorReference; b: ConnectorReference };
} {
  const start = getWorldConnector(module, connectorId);
  if (!start) return { module };
  const candidates = getOpenConnectors(document, pathId)
    .filter(
      (target) =>
        target.module.id !== module.id &&
        target.connector.type === start.type &&
        Math.abs(target.connector.width - start.width) <= 0.01 &&
        Math.abs(
          (target.connector.leftWidth ?? target.connector.width / 2) -
            (start.rightWidth ?? start.width / 2),
        ) <= 0.01 &&
        Math.abs(
          (target.connector.rightWidth ?? target.connector.width / 2) -
            (start.leftWidth ?? start.width / 2),
        ) <= 0.01 &&
        Math.abs(target.connector.position.z - start.position.z) <=
          CONNECTION_TOLERANCE &&
        distance(start.position, target.connector.position) <= snapDistance,
    )
    .sort(
      (a, b) =>
        distance(start.position, a.connector.position) -
        distance(start.position, b.connector.position),
    );
  const best = candidates[0];
  if (!best) return { module };
  const local = createModuleGeometry(
    module.definitionId,
    module.parameters,
    module.controlPoints,
  )!.connectors.find((c) => c.id === connectorId)!;
  const rotation = best.connector.tangent + Math.PI - local.tangent;
  const offset = rotate(local.position, rotation);
  return {
    module: {
      ...module,
      transform: {
        position: {
          x: best.connector.position.x - offset.x,
          y: best.connector.position.y - offset.y,
          z: best.connector.position.z - local.position.z,
        },
        rotation,
      },
    },
    connection: {
      a: { moduleId: best.module.id, connectorId: best.connector.id },
      b: { moduleId: module.id, connectorId },
    },
  };
}
function polygonsOverlap(a: Vec2[], b: Vec2[]): boolean {
  for (const polygon of [a, b])
    for (let i = 0; i < polygon.length; i++) {
      const p = polygon[i],
        q = polygon[(i + 1) % polygon.length],
        normal = normalize({ x: p.y - q.y, y: q.x - p.x });
      const ap = a.map((v) => v.x * normal.x + v.y * normal.y),
        bp = b.map((v) => v.x * normal.x + v.y * normal.y);
      if (
        Math.min(...ap) >= Math.max(...bp) - 0.01 ||
        Math.min(...bp) >= Math.max(...ap) - 0.01
      )
        return false;
    }
  return true;
}
export function modulesOverlap(
  a: TrackModule,
  b: TrackModule,
  allowAt?: (point: Vec2) => boolean,
  minimumClearance = 5,
): boolean {
  const ap = buildModulePaths(a),
    bp = buildModulePaths(b);
  const pa = {
      leftBoundary: ap.flatMap((p) => p.leftBoundary),
      rightBoundary: ap.flatMap((p) => p.rightBoundary),
      drivablePolygons: ap.flatMap((p) => p.drivablePolygons),
    },
    pb = {
      leftBoundary: bp.flatMap((p) => p.leftBoundary),
      rightBoundary: bp.flatMap((p) => p.rightBoundary),
      drivablePolygons: bp.flatMap((p) => p.drivablePolygons),
    };
  const ba = boundsFromPoints([...pa.leftBoundary, ...pa.rightBoundary]),
    bb = boundsFromPoints([...pb.leftBoundary, ...pb.rightBoundary]);
  if (
    ba.max.x <= bb.min.x ||
    bb.max.x <= ba.min.x ||
    ba.max.y <= bb.min.y ||
    bb.max.y <= ba.min.y
  )
    return false;
  return pa.drivablePolygons.some((polygon) =>
    pb.drivablePolygons.some(
      (other) =>
        polygonsOverlap(polygon, other) &&
        Math.max(
          Math.min(...polygon.map((p) => p.z)) -
            Math.max(...other.map((p) => p.z)),
          Math.min(...other.map((p) => p.z)) -
            Math.max(...polygon.map((p) => p.z)),
        ) < minimumClearance &&
        !allowAt?.({
          x: polygon.reduce((sum, point) => sum + point.x, 0) / polygon.length,
          y: polygon.reduce((sum, point) => sum + point.y, 0) / polygon.length,
        }),
    ),
  );
}
export function reconcileMarkerAnchors(
  before: TrackDocument,
  after: TrackDocument,
): TrackDocument {
  const previous = buildAllPathGeometries(before),
    next = buildAllPathGeometries(after);
  return {
    ...after,
    markers: after.markers.map((marker) => {
      const anchor = marker.location.anchor,
        old = before.markers.find((item) => item.id === marker.id),
        path = next[marker.location.pathId]?.path;
      if (
        !anchor ||
        !old ||
        !path ||
        !previous[marker.location.pathId] ||
        old.location.distanceMeters !== marker.location.distanceMeters ||
        anchor.localT < 0 ||
        anchor.localT > 1
      )
        return marker;
      const samples = path.samples.filter(
        (sample) =>
          sample.moduleId === anchor.moduleId &&
          (!anchor.traversalId || sample.traversalId === anchor.traversalId),
      );
      if (!samples.length) return marker;
      const first = samples[0],
        last = samples.at(-1)!;
      return {
        ...marker,
        location: {
          ...marker.location,
          distanceMeters: path.wrapDistance(
            lerp(
              first.s,
              last.s,
              (anchor.localT - first.localT) /
                (last.localT - first.localT || 1),
            ),
          ),
        },
      };
    }),
  };
}
