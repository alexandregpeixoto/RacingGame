import type {
  ConnectorDefinition,
  ModuleDefinition,
  ModuleGeometry,
  ParametricCurve,
  Vec3,
} from "./types";
import { clamp, lerp, TAU } from "./math";
import { ADVANCED_MODULE_DEFINITIONS } from "./advancedModules";

class LineCurve implements ParametricCurve {
  constructor(
    private readonly lengthMeters: number,
    private readonly elevationDelta: number,
  ) {}
  evaluate(t: number): Vec3 {
    const u = clamp(t, 0, 1);
    return { x: this.lengthMeters * u, y: 0, z: this.elevationDelta * u };
  }
  tangent(): Vec3 {
    const magnitude = Math.hypot(this.lengthMeters, this.elevationDelta) || 1;
    return {
      x: this.lengthMeters / magnitude,
      y: 0,
      z: this.elevationDelta / magnitude,
    };
  }
  curvature(): number {
    return 0;
  }
  length(): number {
    return Math.hypot(this.lengthMeters, this.elevationDelta);
  }
}

class ArcCurve implements ParametricCurve {
  constructor(
    private readonly radius: number,
    private readonly angle: number,
    private readonly elevationDelta: number,
  ) {}
  evaluate(t: number): Vec3 {
    const u = clamp(t, 0, 1);
    const theta = this.angle * u;
    return {
      x: this.radius * Math.sin(theta) * Math.sign(this.angle),
      y: this.radius * (1 - Math.cos(theta)) * Math.sign(this.angle),
      z: this.elevationDelta * u,
    };
  }
  tangent(t: number): Vec3 {
    const theta = this.angle * clamp(t, 0, 1);
    const dx = Math.cos(theta);
    const dy = Math.sin(theta);
    const planarLength = Math.hypot(dx, dy) || 1;
    const grade =
      this.elevationDelta / Math.max(0.001, Math.abs(this.radius * this.angle));
    const magnitude = Math.hypot(planarLength, grade);
    return { x: dx / magnitude, y: dy / magnitude, z: grade / magnitude };
  }
  curvature(): number {
    const pitch = this.elevationDelta / Math.max(0.001, Math.abs(this.angle));
    return this.radius / (this.radius ** 2 + pitch ** 2);
  }
  length(): number {
    return Math.hypot(this.radius * this.angle, this.elevationDelta);
  }
}

function commonConnectors(
  end: Vec3,
  endTangent: number,
  width: number,
): ConnectorDefinition[] {
  return [
    {
      id: "start",
      position: { x: 0, y: 0, z: 0 },
      tangent: Math.PI,
      width,
      type: "track",
    },
    { id: "end", position: end, tangent: endTangent, width, type: "track" },
  ];
}

export const MODULE_DEFINITIONS: ModuleDefinition[] = [
  {
    id: "straight",
    label: "Straight",
    category: "straight",
    defaultParameters: { length: 40, width: 10, elevationDelta: 0 },
    createGeometry(parameters) {
      const length = Math.max(2, parameters.length ?? 40);
      const width = Math.max(2, parameters.width ?? 10);
      const elevationDelta = parameters.elevationDelta ?? 0;
      return {
        curve: new LineCurve(length, elevationDelta),
        width,
        connectors: commonConnectors(
          { x: length, y: 0, z: elevationDelta },
          0,
          width,
        ),
      };
    },
  },
  {
    id: "curve-left",
    label: "Left Curve",
    category: "curve",
    defaultParameters: {
      radius: 30,
      angle: Math.PI / 2,
      width: 10,
      elevationDelta: 0,
    },
    createGeometry(parameters) {
      const radius = Math.max(3, parameters.radius ?? 30);
      const angle = clamp(parameters.angle ?? Math.PI / 2, Math.PI / 12, TAU);
      const width = Math.max(2, parameters.width ?? 10);
      const elevationDelta = parameters.elevationDelta ?? 0;
      return {
        curve: new ArcCurve(radius, angle, elevationDelta),
        width,
        connectors: commonConnectors(
          new ArcCurve(radius, angle, elevationDelta).evaluate(1),
          angle,
          width,
        ),
      };
    },
  },
  {
    id: "curve-right",
    label: "Right Curve",
    category: "curve",
    defaultParameters: {
      radius: 30,
      angle: Math.PI / 2,
      width: 10,
      elevationDelta: 0,
    },
    createGeometry(parameters) {
      const radius = Math.max(3, parameters.radius ?? 30);
      const angle = -clamp(parameters.angle ?? Math.PI / 2, Math.PI / 12, TAU);
      const width = Math.max(2, parameters.width ?? 10);
      const elevationDelta = parameters.elevationDelta ?? 0;
      return {
        curve: new ArcCurve(radius, angle, elevationDelta),
        width,
        connectors: commonConnectors(
          new ArcCurve(radius, angle, elevationDelta).evaluate(1),
          angle,
          width,
        ),
      };
    },
  },
  ...ADVANCED_MODULE_DEFINITIONS,
];

export const MODULE_MAP = new Map(
  MODULE_DEFINITIONS.map((definition) => [definition.id, definition]),
);

export function getModuleDefinition(id: string): ModuleDefinition | undefined {
  return MODULE_MAP.get(id as ModuleDefinition["id"]);
}

const geometryCache = new Map<string, ModuleGeometry>();
export function createModuleGeometry(
  definitionId: string,
  parameters: Record<string, number>,
  controlPoints?: import("./types").PathControlPoint[],
): ModuleGeometry | undefined {
  const key = JSON.stringify([definitionId, parameters, controlPoints]);
  const cached = geometryCache.get(key);
  if (cached) return cached;
  const definition = getModuleDefinition(definitionId);
  const geometry = definition?.createGeometry(
    { ...definition.defaultParameters, ...parameters },
    controlPoints,
  );
  if (geometry && !geometry.traversals)
    geometry.traversals = [
      {
        id: "main",
        entry: "start",
        exit: "end",
        curve: geometry.curve,
        widthAt: () => ({
          left: geometry.width / 2,
          right: geometry.width / 2,
        }),
      },
    ];
  if (geometry) {
    if (geometryCache.size > 256)
      geometryCache.delete(geometryCache.keys().next().value!);
    geometryCache.set(key, geometry);
  }
  return geometry;
}

export function moduleParameterErrors(
  module: import("./types").TrackModule,
): string[] {
  const definition = getModuleDefinition(module.definitionId);
  if (!definition) return ["Unknown module definition"];
  const p = { ...definition.defaultParameters, ...module.parameters };
  const errors: string[] = [];
  if (Object.values(p).some((v) => !Number.isFinite(v)))
    errors.push("Parameters must be finite");
  if (p.width < 2 || (p.length !== undefined && p.length < 2))
    errors.push("Width and length must be at least 2 m");
  for (const key of ["endWidth", "branchWidth"])
    if (p[key] !== undefined && p[key] < 2)
      errors.push(`${key} must be at least 2 m`);
  for (const key of ["leftStart", "leftEnd", "rightStart", "rightEnd"])
    if (p[key] !== undefined && p[key] <= 0)
      errors.push(`${key} must be positive`);
  if (definition.category === "curve" && p.radius !== undefined) {
    if (
      p.radius <= p.width / 2 ||
      p.radius < 3 ||
      p.angle < Math.PI / 12 ||
      p.angle > Math.PI * 2
    )
      errors.push("Invalid radius or angle");
  }
  if (module.definitionId.startsWith("compound-")) {
    if (
      !Number.isInteger(p.sectionCount) ||
      p.sectionCount < 2 ||
      p.sectionCount > 12
    )
      errors.push("Compound sections must be an integer from 2 to 12");
    for (let i = 1; i <= Math.min(12, p.sectionCount); i++) {
      const radius = p[i === 1 ? "radius" : `radius${i}`] ?? p.radius,
        angle = p[`angle${i}`] ?? p.angle / p.sectionCount;
      if (radius <= p.width / 2 || angle <= 0 || angle > Math.PI * 2)
        errors.push("Invalid compound section radius or angle");
    }
  }
  if (
    p.rampLength !== undefined &&
    (p.rampLength <= 0 || p.rampLength * 2 > p.length || p.rise <= 0)
  )
    errors.push("Ramps must fit the module and rise must be positive");
  if (
    module.controlPoints &&
    (module.controlPoints.length < 2 ||
      new Set(module.controlPoints.map((p) => p.id)).size !==
        module.controlPoints.length)
  )
    errors.push("Freeform requires distinct control point IDs");
  if (!errors.length) {
    const generated = createModuleGeometry(
      module.definitionId,
      p,
      module.controlPoints,
    );
    if (generated?.traversals?.some((t) => t.curve.length() < 2))
      errors.push("Each traversal must be at least 2 m long");
  }
  if (
    ["widening", "flare"].includes(module.definitionId) &&
    p.endWidth < p.width
  )
    errors.push("An expanding section must end at least as wide as it starts");
  if (
    ["narrowing", "funnel"].includes(module.definitionId) &&
    p.endWidth > p.width
  )
    errors.push("A converging section must end no wider than it starts");
  return errors;
}
