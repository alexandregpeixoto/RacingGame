import type { ConnectorDefinition, ModuleDefinition, ModuleGeometry, ParametricCurve, Vec3 } from "./types";
import { clamp, lerp, TAU } from "./math";

class LineCurve implements ParametricCurve {
  constructor(private readonly lengthMeters: number, private readonly elevationDelta: number) {}
  evaluate(t: number): Vec3 {
    const u = clamp(t, 0, 1);
    return { x: this.lengthMeters * u, y: 0, z: this.elevationDelta * u };
  }
  tangent(): Vec3 {
    const magnitude = Math.hypot(this.lengthMeters, this.elevationDelta) || 1;
    return { x: this.lengthMeters / magnitude, y: 0, z: this.elevationDelta / magnitude };
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
      x: this.radius * Math.sin(theta),
      y: this.radius * (1 - Math.cos(theta)),
      z: this.elevationDelta * u,
    };
  }
  tangent(t: number): Vec3 {
    const theta = this.angle * clamp(t, 0, 1);
    const sign = Math.sign(this.angle) || 1;
    const dx = Math.cos(theta) * sign;
    const dy = Math.sin(theta) * sign;
    const planarLength = Math.hypot(dx, dy) || 1;
    const grade = this.elevationDelta / Math.max(0.001, Math.abs(this.radius * this.angle));
    const magnitude = Math.hypot(planarLength, grade);
    return { x: dx / magnitude, y: dy / magnitude, z: grade / magnitude };
  }
  curvature(): number {
    return this.angle === 0 ? 0 : 1 / Math.abs(this.radius);
  }
  length(): number {
    return Math.abs(this.radius * this.angle) * Math.sqrt(1 + Math.pow(this.elevationDelta / Math.max(0.001, this.radius * this.angle), 2));
  }
}

function commonConnectors(end: Vec3, endTangent: number, width: number): ConnectorDefinition[] {
  return [
    { id: "start", position: { x: 0, y: 0, z: 0 }, tangent: Math.PI, width, type: "track" },
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
      return { curve: new LineCurve(length, elevationDelta), width, connectors: commonConnectors({ x: length, y: 0, z: elevationDelta }, 0, width) };
    },
  },
  {
    id: "curve-left",
    label: "Left Curve",
    category: "curve",
    defaultParameters: { radius: 30, angle: Math.PI / 2, width: 10, elevationDelta: 0 },
    createGeometry(parameters) {
      const radius = Math.max(3, parameters.radius ?? 30);
      const angle = clamp(parameters.angle ?? Math.PI / 2, Math.PI / 12, TAU);
      const width = Math.max(2, parameters.width ?? 10);
      const elevationDelta = parameters.elevationDelta ?? 0;
      return {
        curve: new ArcCurve(radius, angle, elevationDelta),
        width,
        connectors: commonConnectors({ x: radius * Math.sin(angle), y: radius * (1 - Math.cos(angle)), z: elevationDelta }, angle, width),
      };
    },
  },
  {
    id: "curve-right",
    label: "Right Curve",
    category: "curve",
    defaultParameters: { radius: 30, angle: Math.PI / 2, width: 10, elevationDelta: 0 },
    createGeometry(parameters) {
      const radius = Math.max(3, parameters.radius ?? 30);
      const angle = -clamp(parameters.angle ?? Math.PI / 2, Math.PI / 12, TAU);
      const width = Math.max(2, parameters.width ?? 10);
      const elevationDelta = parameters.elevationDelta ?? 0;
      return {
        curve: new ArcCurve(radius, angle, elevationDelta),
        width,
        connectors: commonConnectors({ x: radius * Math.sin(angle), y: radius * (1 - Math.cos(angle)), z: elevationDelta }, angle, width),
      };
    },
  },
];

export const MODULE_MAP = new Map(MODULE_DEFINITIONS.map((definition) => [definition.id, definition]));

export function getModuleDefinition(id: string): ModuleDefinition | undefined {
  return MODULE_MAP.get(id as ModuleDefinition["id"]);
}

export function createModuleGeometry(definitionId: string, parameters: Record<string, number>): ModuleGeometry | undefined {
  return getModuleDefinition(definitionId)?.createGeometry(parameters);
}
