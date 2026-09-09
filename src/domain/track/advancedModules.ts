import type {
  ModuleDefinition,
  ModuleGeometry,
  ModuleTraversal,
  ParametricCurve,
  PathControlPoint,
  Vec3,
} from "./types";
import { clamp, lerp, lerpVec3 } from "./math";

const smooth = (t: number) => {
  const u = clamp(t, 0, 1);
  return u ** 3 * (10 - 15 * u + 6 * u * u);
};
const unit = (v: Vec3): Vec3 => {
  const n = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / n, y: v.y / n, z: v.z / n };
};

/** Arc-length parameterized lookup: distance queries and anchors share one metric. */
export class DistanceCurve implements ParametricCurve {
  private points: Vec3[];
  private distances = [0];
  private tangents: Vec3[];
  constructor(evaluate: (t: number) => Vec3, count = 512) {
    this.points = Array.from({ length: count + 1 }, (_, i) =>
      evaluate(i / count),
    );
    for (let i = 1; i <= count; i++) {
      const a = this.points[i - 1],
        b = this.points[i];
      this.distances.push(
        this.distances[i - 1] + Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z),
      );
    }
    this.tangents = this.points.map((_, i) => {
      const t = i / count,
        h = 1e-6;
      const a = evaluate(Math.max(0, t - h)),
        b = evaluate(Math.min(1, t + h));
      return unit({ x: b.x - a.x, y: b.y - a.y, z: b.z - a.z });
    });
  }
  private interval(t: number) {
    const s = clamp(t, 0, 1) * this.length();
    let lo = 1,
      hi = this.points.length - 1;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (this.distances[m] < s) lo = m + 1;
      else hi = m;
    }
    return {
      i: lo,
      u:
        (s - this.distances[lo - 1]) /
        (this.distances[lo] - this.distances[lo - 1] || 1),
    };
  }
  evaluate(t: number) {
    const { i, u } = this.interval(t);
    return lerpVec3(this.points[i - 1], this.points[i], u);
  }
  tangent(t: number) {
    const { i, u } = this.interval(t);
    return unit(lerpVec3(this.tangents[i - 1], this.tangents[i], u));
  }
  curvature(t: number) {
    const { i } = this.interval(t),
      a = this.tangents[i - 1],
      b = this.tangents[i];
    return (
      Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) /
      Math.max(1e-9, this.distances[i] - this.distances[i - 1])
    );
  }
  length() {
    return this.distances.at(-1)!;
  }
}

export function bezierModuleCurve(points: PathControlPoint[]): ParametricCurve {
  return new DistanceCurve((t) => {
    const n = points.length - 1,
      index = Math.min(n - 1, Math.floor(t * n)),
      u = t * n - index,
      v = 1 - u;
    const a = points[index],
      b = points[index + 1];
    return {
      x:
        v ** 3 * a.position.x +
        3 * v * v * u * (a.position.x + a.outHandle.x) +
        3 * v * u * u * (b.position.x + b.inHandle.x) +
        u ** 3 * b.position.x,
      y:
        v ** 3 * a.position.y +
        3 * v * v * u * (a.position.y + a.outHandle.y) +
        3 * v * u * u * (b.position.y + b.inHandle.y) +
        u ** 3 * b.position.y,
      z: lerp(a.position.z, b.position.z, smooth(u)),
    };
  });
}

export function defaultFreeform(length = 60, offset = 20): PathControlPoint[] {
  return [
    {
      id: "p0",
      position: { x: 0, y: 0, z: 0 },
      inHandle: { x: -length / 3, y: 0 },
      outHandle: { x: length / 3, y: 0 },
    },
    {
      id: "p1",
      position: { x: length, y: offset, z: 0 },
      inHandle: { x: -length / 3, y: 0 },
      outHandle: { x: length / 3, y: 0 },
    },
  ];
}

function geometry(traversals: ModuleTraversal[]): ModuleGeometry {
  const connectors = traversals
    .flatMap((route) =>
      [false, true].map((end) => {
        const t = end ? 1 : 0,
          tangent = route.curve.tangent(t),
          widths = route.widthAt(t);
        return {
          id: end ? route.exit : route.entry,
          position: route.curve.evaluate(t),
          tangent: Math.atan2(tangent.y, tangent.x) + (end ? 0 : Math.PI),
          width: widths.left + widths.right,
          leftWidth: end ? widths.left : widths.right,
          rightWidth: end ? widths.right : widths.left,
          type: "track" as const,
        };
      }),
    )
    .filter(
      (port, i, ports) =>
        ports.findIndex((other) => other.id === port.id) === i,
    );
  return {
    curve: traversals[0].curve,
    width: connectors[0].width,
    connectors,
    traversals,
  };
}
const lane = (
  curve: ParametricCurve,
  width: number,
  id = "main",
  entry = "start",
  exit = "end",
): ModuleTraversal => ({
  id,
  entry,
  exit,
  curve,
  widthAt: () => ({ left: width / 2, right: width / 2 }),
});

function headingCurve(
  length: number,
  heading: (t: number) => number,
  elevation: number,
) {
  const n = 1024,
    points: Vec3[] = [{ x: 0, y: 0, z: 0 }];
  for (let i = 1; i <= n; i++) {
    const a = heading((i - 0.5) / n),
      p = points[i - 1];
    points.push({
      x: p.x + (Math.cos(a) * length) / n,
      y: p.y + (Math.sin(a) * length) / n,
      z: (elevation * i) / n,
    });
  }
  return new DistanceCurve((t) => {
    const i = Math.min(n - 1, Math.floor(t * n));
    return lerpVec3(points[i], points[i + 1], t * n - i);
  });
}

function corner(
  id: string,
  label: string,
  sign: number,
  family: string,
): ModuleDefinition {
  const tight = family === "switchback" || family === "chicane";
  return {
    id,
    label,
    category: "curve",
    defaultParameters: {
      width: 10,
      radius: tight ? 18 : 35,
      radius2: tight ? 18 : 55,
      radius3: 35,
      ...(family === "compound" ? { sectionCount: 3 } : {}),
      ...(family === "double" ? { openRadius: 90 } : {}),
      angle:
        family === "switchback"
          ? Math.PI * 0.85
          : family === "chicane"
            ? Math.PI / 3
            : Math.PI / 2,
      separation: tight ? 12 : 20,
      elevationDelta: 0,
    },
    createGeometry(p) {
      const r = Math.max(6, p.radius),
        r2 = Math.max(6, p.radius2),
        angle = p.angle,
        separation = Math.max(0, p.separation);
      let length: number, heading: (t: number) => number;
      if (["s", "chicane", "switchback"].includes(family)) {
        const bend = r * angle * (family === "s" ? 1.875 : 1),
          bend2 = r2 * angle * (family === "s" ? 1.875 : 1),
          total = bend + bend2 + separation;
        length = total;
        heading = (t) => {
          const s = t * total;
          if (family === "s")
            return (
              sign *
              angle *
              (s < bend
                ? smooth(s / bend)
                : s < bend + separation
                  ? 1
                  : 1 - smooth((s - bend - separation) / bend2))
            );
          return (
            sign *
            (s < bend
              ? s / r
              : s < bend + separation
                ? angle
                : angle - (s - bend - separation) / r2)
          );
        };
      } else if (family === "increasing" || family === "decreasing") {
        const start =
            family === "increasing" ? Math.min(r, r2) : Math.max(r, r2),
          end = family === "increasing" ? Math.max(r, r2) : Math.min(r, r2);
        length = angle / ((1 / start + 1 / end) / 2);
        heading = (t) =>
          sign * length * (t / start + ((1 / end - 1 / start) * t * t) / 2);
      } else if (family === "double") {
        const open = Math.max(r, r2, p.openRadius ?? 90),
          middle = Math.min(
            0.4,
            separation / (r * angle + r2 * angle + separation),
          );
        const knots = [
            0,
            0.25 - middle / 4,
            0.5 - middle / 2,
            0.5 + middle / 2,
            0.75 + middle / 4,
            1,
          ],
          ks = [1 / open, 1 / r, 1 / open, 1 / open, 1 / r2, 1 / open];
        const k = (t: number) => {
          const i = Math.min(
            4,
            Math.max(0, knots.findIndex((v) => v >= t) - 1),
          );
          return lerp(
            ks[i],
            ks[i + 1],
            smooth((t - knots[i]) / (knots[i + 1] - knots[i])),
          );
        };
        const integrated = [0];
        for (let i = 1; i <= 1024; i++)
          integrated.push(
            integrated[i - 1] + (k((i - 1) / 1024) + k(i / 1024)) / 2048,
          );
        length = angle / integrated[1024];
        heading = (t) => {
          const i = Math.min(1023, Math.floor(t * 1024));
          return (
            sign * length * lerp(integrated[i], integrated[i + 1], t * 1024 - i)
          );
        };
      } else {
        const count = clamp(Math.floor(p.sectionCount ?? 3), 2, 12);
        const sections = Array.from({ length: count }, (_, i) => ({
          radius: Math.max(6, p[i === 0 ? "radius" : `radius${i + 1}`] ?? r),
          angle: p[`angle${i + 1}`] ?? angle / count,
        }));
        length = sections.reduce((sum, s) => sum + s.radius * s.angle, 0);
        heading = (t) => {
          let remaining = t * length,
            heading = 0;
          for (const s of sections) {
            const traveled = Math.min(s.radius * s.angle, remaining);
            heading += traveled / s.radius;
            remaining -= traveled;
            if (remaining <= 0) break;
          }
          return sign * heading;
        };
      }
      return geometry([
        lane(headingCurve(length, heading, p.elevationDelta ?? 0), p.width),
      ]);
    },
  };
}

const curves = [
  ["s-curve", "S-Curve", "s"],
  ["chicane", "Chicane", "chicane"],
  ["double-apex", "Double Apex", "double"],
  ["increasing-radius", "Increasing Radius", "increasing"],
  ["decreasing-radius", "Decreasing Radius", "decreasing"],
  ["compound", "Compound", "compound"],
  ["switchback", "Switchback", "switchback"],
].flatMap(([id, label, family]) =>
  [1, -1].map((sign) =>
    corner(
      `${id}-${sign === 1 ? "left" : "right"}`,
      `${label} ${["s", "chicane", "switchback"].includes(family) ? (sign === 1 ? "L → R" : "R → L") : sign === 1 ? "Left" : "Right"}`,
      sign,
      family,
    ),
  ),
);

const transitions: ModuleDefinition[] = [
  "widening",
  "narrowing",
  "offset-left",
  "offset-right",
  "asymmetric-transition",
  "funnel",
  "flare",
].map((id) => ({
  id,
  label: (
    {
      widening: "Widening Section",
      narrowing: "Narrowing Section",
      "offset-left": "Offset Left",
      "offset-right": "Offset Right",
      "asymmetric-transition": "Asymmetric Transition",
      funnel: "Funnel",
      flare: "Flare",
    } as Record<string, string>
  )[id],
  category: "transition",
  defaultParameters: {
    length: 60,
    width: 10,
    endWidth: ["narrowing", "funnel"].includes(id) ? 6 : 16,
    offset: 15,
    leftStart: 5,
    rightStart: 5,
    leftEnd: 9,
    rightEnd: 6,
    elevationDelta: 0,
  },
  createGeometry(p) {
    const offset = id.startsWith("offset"),
      asymmetric = id === "asymmetric-transition";
    const curve = new DistanceCurve((t) => ({
      x: p.length * t,
      y: offset ? p.offset * (id === "offset-right" ? -1 : 1) * smooth(t) : 0,
      z: (p.elevationDelta ?? 0) * t,
    }));
    const route = lane(curve, p.width);
    route.widthAt = (t) => ({
      left: asymmetric
        ? lerp(p.leftStart, p.leftEnd, smooth(t))
        : lerp(p.width, offset ? p.width : p.endWidth, smooth(t)) / 2,
      right: asymmetric
        ? lerp(p.rightStart, p.rightEnd, smooth(t))
        : lerp(p.width, offset ? p.width : p.endWidth, smooth(t)) / 2,
    });
    return geometry([route]);
  },
}));

const topology: ModuleDefinition[] = [
  "track-split",
  "track-merge",
  "crossover",
  "overpass",
  "underpass",
  "shortcut-branch",
  "joker-lap-entry",
  "joker-lap-exit",
  "service-road-junction",
  "pit-entry",
  "pit-exit",
].map((id): ModuleDefinition => ({
  id,
  label: id
    .split("-")
    .map((v) => v[0].toUpperCase() + v.slice(1))
    .join(" "),
  category: id.startsWith("pit") ? "pit" : "topology",
  defaultParameters:
    id === "overpass" || id === "underpass"
      ? { length: 200, width: 10, rise: 6, rampLength: 75, elevationDelta: 0 }
      : {
          length: 80,
          width: 10,
          branchWidth: id.includes("pit") ? 6 : 10,
          offset: 30,
          side: 1,
          angle: Math.PI / 6,
          elevationDelta: 0,
        },
  createGeometry(p) {
    const length = p.length,
      elevation = p.elevationDelta ?? 0;
    const bridge = id === "overpass" || id === "underpass";
    const main = lane(
      new DistanceCurve((t) => ({
        x: length * t,
        y: 0,
        z:
          elevation * t +
          (bridge
            ? (id === "underpass" ? -1 : 1) *
              p.rise *
              Math.min(
                smooth((t * length) / p.rampLength),
                smooth(((1 - t) * length) / p.rampLength),
              )
            : 0),
      })),
      p.width,
    );
    if (bridge) return geometry([main]);
    if (id === "crossover")
      return geometry([
        main,
        lane(
          new DistanceCurve((t) => ({
            x: length / 2,
            y: length * (t - 0.5),
            z: elevation * t,
          })),
          p.width,
          "crossing",
          "cross-start",
          "cross-end",
        ),
      ]);
    const merge = id.includes("merge") || id.endsWith("exit"),
      side = p.side < 0 ? -1 : 1;
    const points = defaultFreeform(length, side * p.offset);
    points[1].inHandle = {
      x: (-length / 3) * Math.cos(p.angle),
      y: ((-side * length) / 3) * Math.sin(p.angle),
    };
    if (merge) {
      points[0].position.y = side * p.offset;
      points[1].position.y = 0;
      points[0].outHandle = {
        x: (length / 3) * Math.cos(p.angle),
        y: ((-side * length) / 3) * Math.sin(p.angle),
      };
      points[1].inHandle = { x: -length / 3, y: 0 };
    }
    points[1].position.z = elevation;
    const branch = lane(
      bezierModuleCurve(points),
      p.branchWidth,
      "branch",
      merge ? "branch" : "start",
      merge ? "end" : "branch",
    );
    branch.widthAt = (t) => {
      const width = lerp(
        merge ? p.branchWidth : p.width,
        merge ? p.width : p.branchWidth,
        smooth(t),
      );
      return { left: width / 2, right: width / 2 };
    };
    return geometry([main, branch]);
  },
}));

export const ADVANCED_MODULE_DEFINITIONS: ModuleDefinition[] = [
  ...curves,
  ...transitions,
  ...topology,
  ...["freeform-curve", "loop-connector"].map((id): ModuleDefinition => ({
    id,
    label: id === "freeform-curve" ? "Freeform Curve" : "Loop Connector",
    category: id === "freeform-curve" ? "curve" : "topology",
    defaultParameters: { length: 60, offset: 20, width: 10, elevationDelta: 0 },
    createGeometry(p, points) {
      const controls =
        points?.length && points.length >= 2
          ? points
          : defaultFreeform(p.length, p.offset);
      return geometry([lane(bezierModuleCurve(controls), p.width)]);
    },
  })),
];
