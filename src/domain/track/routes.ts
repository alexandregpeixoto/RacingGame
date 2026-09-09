import type { TrackDocument } from "./types";
import { buildPathGeometry } from "./geometry";
import { id } from "./document";

/** Materialize semantic pit lines at explicit shared junction traversals. */
export function syncPitJunctions(document: TrackDocument): TrackDocument {
  const primary = document.paths.find((p) => p.kind === "primary-loop");
  const main = primary && buildPathGeometry(document, primary.id)?.path;
  if (!main || !primary) return document;
  for (const pit of document.paths.filter(
    (p) => p.kind === "pit" && p.traversals?.length,
  )) {
    for (const [step, type, field] of [
      [pit.traversals![0], "pit-entry", "entryMarkerId"],
      [pit.traversals!.at(-1)!, "pit-exit", "exitMarkerId"],
    ] as const) {
      const module = document.modules.find((m) => m.id === step.moduleId);
      if (
        !module ||
        step.traversalId !== "branch" ||
        !primary.sourceModuleIds.includes(module.id) ||
        module.definitionId !== type
      )
        continue;
      const sample = main.samples.find(
        (s) =>
          s.moduleId === module.id &&
          Math.abs(s.localT - (type === "pit-entry" ? 0 : 1)) < 1e-6,
      );
      if (!sample) continue;
      let marker = document.markers.find((m) => m.id === pit[field]);
      if (!marker) {
        marker = {
          id: id(type),
          type,
          location: { pathId: primary.id, distanceMeters: sample.s },
          configuration: {},
        };
        document.markers.push(marker);
        pit[field] = marker.id;
      }
      marker.location = {
        pathId: primary.id,
        distanceMeters: main.wrapDistance(sample.s),
        anchor: {
          moduleId: module.id,
          localT: sample.localT,
          traversalId: sample.traversalId,
        },
      };
    }
  }
  return document;
}
