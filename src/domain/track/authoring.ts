import type { SampledPath, SpectatorFrame, TrackDocument, Vec2 } from "./types";
import { buildPathGeometry } from "./geometry";
import { boundsFromPoints, normalize, rotate } from "./math";

export function generateGrid(document: TrackDocument, path?: SampledPath) {
  path ??= buildPathGeometry(document, document.grid.pathId)?.path;
  const start = document.markers.find(
    (marker) =>
      marker.id === document.grid.startMarkerId &&
      marker.type === "start-finish" &&
      marker.location.pathId === document.grid.pathId,
  );
  if (!path || !start) return [];
  return Array.from({ length: document.grid.slotCount }, (_, index) => {
    const override = document.grid.slots.find(
      (slot) => slot.slot === index + 1,
    );
    const s =
      start.location.distanceMeters -
      index * document.grid.longitudinalSpacingMeters +
      (override?.distanceOffsetMeters ?? 0);
    const sample = path!.sampleAtDistance(s),
      tangent = normalize(sample.tangent);
    const lateral =
      override?.lateralOffsetMeters ??
      (document.grid.staggerPattern === "alternating"
        ? ((index % 2 === 0 ? -1 : 1) * document.grid.lateralSpacingMeters) / 2
        : 0);
    return {
      slot: index + 1,
      distanceMeters: path!.wrapDistance(s),
      position: {
        x: sample.position.x - tangent.y * lateral,
        y: sample.position.y + tangent.x * lateral,
        z: sample.position.z,
      },
      tangent,
    };
  });
}
export function insideSpectatorFrame(
  frame: SpectatorFrame,
  point: Vec2,
): boolean {
  const local = rotate(
    { x: point.x - frame.center.x, y: point.y - frame.center.y },
    -frame.rotation,
  );
  return (
    local.x >= -frame.size.x / 2 + frame.margins.left - 1e-6 &&
    local.x <= frame.size.x / 2 - frame.margins.right + 1e-6 &&
    local.y >= -frame.size.y / 2 + frame.margins.bottom - 1e-6 &&
    local.y <= frame.size.y / 2 - frame.margins.top + 1e-6
  );
}
export function fitSpectatorFrame(
  frame: SpectatorFrame,
  points: Vec2[],
): SpectatorFrame {
  if (!points.length) return frame;
  const bounds = boundsFromPoints(
    points.map((point) => rotate(point, -frame.rotation)),
  );
  const center = rotate(
    {
      x:
        (bounds.min.x +
          bounds.max.x +
          frame.margins.right -
          frame.margins.left) /
        2,
      y:
        (bounds.min.y +
          bounds.max.y +
          frame.margins.top -
          frame.margins.bottom) /
        2,
    },
    frame.rotation,
  );
  const paddedWidth = Math.max(
    1,
    bounds.max.x - bounds.min.x + frame.margins.left + frame.margins.right,
  );
  const paddedHeight = Math.max(
    1,
    bounds.max.y - bounds.min.y + frame.margins.top + frame.margins.bottom,
  );
  const ratio = frame.aspectRatio
    ? frame.aspectRatio.x / frame.aspectRatio.y
    : 16 / 9;
  const width = Math.max(paddedWidth, paddedHeight * ratio);
  return {
    ...frame,
    aspectRatio: frame.aspectRatio ?? { x: 16, y: 9 },
    center,
    size: { x: width, y: width / ratio },
  };
}

export function resizeFrame(
  frame: SpectatorFrame,
  width: number,
): SpectatorFrame {
  if (!Number.isFinite(width) || width <= 0) return frame;
  const aspectRatio = frame.aspectRatio ?? { x: 16, y: 9 };
  return {
    ...frame,
    aspectRatio,
    size: { x: width, y: (width * aspectRatio.y) / aspectRatio.x },
  };
}
export function changeFrameRatio(
  frame: SpectatorFrame,
  ratio: Vec2,
): SpectatorFrame {
  if (![ratio.x, ratio.y].every((n) => Number.isFinite(n) && n > 0))
    return frame;
  return resizeFrame(
    { ...frame, aspectRatio: ratio },
    Math.max(frame.size.x, (frame.size.y * ratio.x) / ratio.y),
  );
}
export function spectatorTrackPoints(document: TrackDocument): Vec2[] {
  return [
    ...document.paths
      .filter((p) => p.kind !== "racing-line" && p.metadata?.role !== "service")
      .flatMap((p) => {
        const geometry = buildPathGeometry(document, p.id);
        return geometry
          ? [...geometry.path.leftBoundary, ...geometry.path.rightBoundary]
          : [];
      }),
    ...generateGrid(document).map((slot) => slot.position),
  ];
}
