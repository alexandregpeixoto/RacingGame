import type { TerrainHeightmap, TrackDocument, Vec2 } from "./types";
import { clamp, lerp } from "./math";
import { buildTrackGeometry, getWorldConnector } from "./geometry";
import { createTerrain } from "./document";

export function terrainHeightAt(
  terrain: TerrainHeightmap,
  point: Vec2,
): number {
  const x = clamp(
    (point.x - terrain.origin.x) / terrain.cellSizeMeters - 0.5,
    0,
    terrain.width - 1,
  );
  const y = clamp(
    (point.y - terrain.origin.y) / terrain.cellSizeMeters - 0.5,
    0,
    terrain.height - 1,
  );
  const x0 = Math.floor(x),
    y0 = Math.floor(y);
  const at = (x: number, y: number) =>
    terrain.elevations[
      Math.min(terrain.height - 1, y) * terrain.width +
        Math.min(terrain.width - 1, x)
    ];
  return lerp(
    lerp(at(x0, y0), at(x0 + 1, y0), x - x0),
    lerp(at(x0, y0 + 1), at(x0 + 1, y0 + 1), x - x0),
    y - y0,
  );
}
export function trackFollowingTerrain(document: TrackDocument): TrackDocument {
  const next = structuredClone(document),
    terrain = next.terrain ?? createTerrain();
  next.terrain = terrain;
  for (const module of next.modules) {
    const start = getWorldConnector(module, "start"),
      end = getWorldConnector(module, "end");
    if (!start || !end) continue;
    module.transform.position.z = terrainHeightAt(terrain, start.position);
    module.parameters.elevationDelta =
      terrainHeightAt(terrain, end.position) - module.transform.position.z;
  }
  return next;
}
export function terrainFollowingTrack(document: TrackDocument): TrackDocument {
  const path = buildTrackGeometry(document)?.path;
  const next = structuredClone(document);
  if (!path) return next;
  const terrain = next.terrain ?? createTerrain();
  next.terrain = terrain;
  for (let y = 0; y < terrain.height; y++)
    for (let x = 0; x < terrain.width; x++) {
      const point = {
        x: terrain.origin.x + (x + 0.5) * terrain.cellSizeMeters,
        y: terrain.origin.y + (y + 0.5) * terrain.cellSizeMeters,
      };
      const projection = path.nearestPoint(point),
        sample = path.sampleAtDistance(projection.distanceMeters);
      if (
        projection.distanceToTrack <=
        sample.width / 2 + terrain.cellSizeMeters * Math.SQRT1_2
      )
        terrain.elevations[y * terrain.width + x] = projection.position.z;
    }
  return next;
}
