import type { Vec2, Vec3 } from "./types";

export const TAU = Math.PI * 2;

export function vec2(x: number, y: number): Vec2 {
  return { x, y };
}

export function rotate(point: Vec2, angle: number): Vec2 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: point.x * c - point.y * s, y: point.x * s + point.y * c };
}

export function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function scale(a: Vec2, value: number): Vec2 {
  return { x: a.x * value, y: a.y * value };
}

export function length(a: Vec2): number {
  return Math.hypot(a.x, a.y);
}

export function normalize(a: Vec2): Vec2 {
  const magnitude = length(a);
  return magnitude < 1e-9 ? { x: 1, y: 0 } : scale(a, 1 / magnitude);
}

export function distance(a: Vec2, b: Vec2): number {
  return length(sub(a, b));
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function lerpVec3(a: Vec3, b: Vec3, t: number): Vec3 {
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), z: lerp(a.z, b.z, t) };
}

export function transformPoint(point: Vec3, position: Vec3, rotation: number): Vec3 {
  const rotated = rotate(point, rotation);
  return { x: rotated.x + position.x, y: rotated.y + position.y, z: point.z + position.z };
}

export function transformAngle(angle: number, rotation: number): number {
  return angle + rotation;
}

export function normalizeAngle(angle: number): number {
  let value = angle % TAU;
  if (value < 0) value += TAU;
  return value;
}

export function angleDelta(a: number, b: number): number {
  let delta = normalizeAngle(a - b);
  if (delta > Math.PI) delta -= TAU;
  return delta;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function boundsFromPoints(points: Vec2[]): { min: Vec2; max: Vec2 } {
  if (points.length === 0) return { min: { x: 0, y: 0 }, max: { x: 0, y: 0 } };
  return points.reduce(
    (bounds, point) => ({
      min: { x: Math.min(bounds.min.x, point.x), y: Math.min(bounds.min.y, point.y) },
      max: { x: Math.max(bounds.max.x, point.x), y: Math.max(bounds.max.y, point.y) },
    }),
    { min: { ...points[0] }, max: { ...points[0] } },
  );
}

export function pointInPolygon(point: Vec2, polygon: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    const intersects = a.y > point.y !== b.y > point.y && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}
