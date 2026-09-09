import type { SampledPath, TrackMarker, TrackZone } from "./types";
export const GHOST_STEP_SECONDS = 1 / 60;
export const GHOST_SPEED_METERS_PER_SECOND = 18;
export interface GhostState {
  tick: number;
  events: Array<{
    markerId: string;
    type: string;
    timeSeconds: number;
    lap: number;
  }>;
}
export const createGhost = (): GhostState => ({ tick: 0, events: [] });
export function ghostPosition(
  state: GhostState,
  path: SampledPath,
  startDistance = 0,
) {
  const elapsed = state.tick * GHOST_STEP_SECONDS;
  const traveled = elapsed * GHOST_SPEED_METERS_PER_SECOND;
  return {
    elapsed,
    distance: path.wrapDistance(startDistance + traveled),
    lap: path.closed ? Math.floor(traveled / path.totalLengthMeters) : 0,
    progress:
      path.totalLengthMeters > 0
        ? (path.closed
            ? traveled % path.totalLengthMeters
            : Math.min(path.totalLengthMeters, startDistance + traveled)) /
          path.totalLengthMeters
        : 0,
  };
}
export function stepGhost(
  state: GhostState,
  path: SampledPath,
  markers: TrackMarker[],
  pathId: string,
  ticks = 1,
  startDistance = 0,
  zones: TrackZone[] = [],
): GhostState {
  const tick = state.tick + Math.max(0, Math.floor(ticks));
  const previous =
    state.tick * GHOST_STEP_SECONDS * GHOST_SPEED_METERS_PER_SECOND;
  const next = tick * GHOST_STEP_SECONDS * GHOST_SPEED_METERS_PER_SECOND;
  if (path.totalLengthMeters <= 0) return state;
  const events: GhostState["events"] = [];
  const controls = [
    ...markers
      .filter((item) => item.location.pathId === pathId)
      .map((m) => ({
        id: m.id,
        type: String(m.configuration.role ?? m.type),
        distance: m.location.distanceMeters,
      })),
    ...zones
      .filter((z) => z.pathId === pathId)
      .flatMap((z) => [
        {
          id: z.id + ":entry",
          type: z.type + " entry",
          distance: z.startMeters,
        },
        { id: z.id + ":exit", type: z.type + " exit", distance: z.endMeters },
      ]),
  ];
  for (const marker of controls) {
    const offset = path.closed
      ? path.wrapDistance(marker.distance - startDistance)
      : marker.distance - startDistance;
    for (
      let lap = Math.max(
        0,
        Math.floor((previous - offset) / path.totalLengthMeters) + 1,
      );
      offset + lap * path.totalLengthMeters <= next + 1e-9 &&
      (path.closed || lap === 0);
      lap++
    ) {
      const distance = offset + lap * path.totalLengthMeters;
      if (distance > previous + 1e-9)
        events.push({
          markerId: marker.id,
          type: marker.type,
          timeSeconds: distance / GHOST_SPEED_METERS_PER_SECOND,
          lap,
        });
    }
  }
  events.sort(
    (a, b) =>
      a.timeSeconds - b.timeSeconds || a.markerId.localeCompare(b.markerId),
  );
  return {
    tick: path.closed
      ? tick
      : Math.min(
          tick,
          Math.ceil(
            (path.totalLengthMeters - startDistance) /
              GHOST_SPEED_METERS_PER_SECOND /
              GHOST_STEP_SECONDS,
          ),
        ),
    events: [...state.events, ...events].slice(-200),
  };
}
