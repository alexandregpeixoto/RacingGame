import { describe, expect, it } from "vitest";
import {
  createControlPoint,
  createSampleDocument,
} from "../../src/domain/track/document";
import {
  prepareModulePlacement,
  pitPathId,
  rebuildPitWithModules,
  attachPitEndpoints,
} from "../../src/domain/track/pit";
import {
  buildPathGeometry,
  buildPrimaryPath,
  connectMatchingConnectors,
  getOpenConnectors,
  snapModuleToOpenConnector,
} from "../../src/domain/track/geometry";
import { validateDocument } from "../../src/domain/track/validation";
import { parseDocument, serializeDocument } from "../../src/persistence";
import type { TrackModule } from "../../src/domain/track/types";

export function modularPitFixture() {
  let document = createSampleDocument();
  const pieces: Array<[TrackModule["definitionId"], number, number]> = [
    ["curve-right", -30, 0],
    ["curve-left", -24, -6],
    ["straight", -18, -12],
    ["curve-left", 18, -12],
    ["curve-right", 24, -6],
  ];
  for (let index = 0; index < pieces.length; index++) {
    const [definitionId, x, y] = pieces[index];
    const module: TrackModule = {
      id: "pit-module-" + index,
      definitionId,
      transform: { position: { x, y, z: 0 }, rotation: 0 },
      parameters: { length: 36, radius: 6, angle: Math.PI / 2, width: 6 },
    };
    const result = prepareModulePlacement(document, module, "pit", 1);
    expect(result.status, "piece " + index).toBe("snap");
    document = result.document;
  }
  return document;
}

describe("modular pit lanes", () => {
  it("builds an open module chain with semantic main-track junctions", () => {
    const original = createSampleDocument(),
      document = modularPitFixture();
    expect(document.modules.slice(0, 4)).toEqual(original.modules);
    expect(document.connections.slice(0, 4)).toEqual(original.connections);
    expect(buildPrimaryPath(document)!.totalLengthMeters).toBeCloseTo(
      buildPrimaryPath(original)!.totalLengthMeters,
    );
    const path = document.paths.find((path) => path.kind === "pit")!;
    expect(path.sourceModuleIds).toHaveLength(5);
    expect(path.controlPoints).toBeUndefined();
    expect(getOpenConnectors(document, path.id)).toHaveLength(2);
    const geometry = buildPathGeometry(document, path.id)!;
    expect(geometry.path.closed).toBe(false);
    expect(geometry.path.positionAtDistance(-10)).toEqual({
      x: -30,
      y: 0,
      z: 0,
    });
    expect(geometry.path.positionAtDistance(1000).x).toBeCloseTo(30);
    expect(geometry.path.totalLengthMeters).toBeCloseTo(36 + 12 * Math.PI);
    expect(
      document.markers.find((marker) => marker.id === path.entryMarkerId)
        ?.location.pathId,
    ).toBe("primary");
    expect(
      document.markers.find((marker) => marker.id === path.exitMarkerId)
        ?.location.pathId,
    ).toBe("primary");
    expect(
      validateDocument(document).issues.filter(
        (issue) => issue.severity === "error",
      ),
    ).toEqual([]);
  });
  it("isolates snapping and automatic connection matching by path", () => {
    const document = modularPitFixture();
    document.connections = [];
    const matched = connectMatchingConnectors(document, "pit");
    expect(matched.connections).toHaveLength(4);
    expect(
      matched.connections.every(
        (connection) =>
          connection.a.moduleId.startsWith("pit-module-") &&
          connection.b.moduleId.startsWith("pit-module-"),
      ),
    ).toBe(true);
    const candidate = {
      ...structuredClone(document.modules[0]),
      id: "candidate",
    };
    const result = snapModuleToOpenConnector(document, candidate, 100, "pit");
    expect(result.connection).toBeUndefined(); // Pit width is 6m, candidate is 10m.
  });
  it("keeps primary geometry available while a pit connection is missing", () => {
    const document = modularPitFixture();
    document.connections = document.connections.filter(
      (connection) => connection.a.moduleId !== "pit-module-1",
    );
    expect(buildPrimaryPath(document)).toBeDefined();
    expect(buildPathGeometry(document, "pit")).toBeUndefined();
    expect(
      validateDocument(document).issues.some(
        (issue) => issue.code === "pit.open-chain",
      ),
    ).toBe(true);
  });
  it("rejects pit junctions with incompatible elevation or orientation", () => {
    const document = modularPitFixture();
    document.modules
      .filter((module) => module.id.startsWith("pit-module"))
      .forEach((module) => (module.transform.position.z = 2));
    expect(
      validateDocument(document).issues.some(
        (issue) => issue.code === "pit.junction-alignment",
      ),
    ).toBe(true);
  });
  it("rejects overlap with the main circuit away from declared junctions", () => {
    const document = modularPitFixture();
    document.modules.find(
      (module) => module.id === "pit-module-2",
    )!.transform.position.y = 0;
    expect(
      validateDocument(document).issues.some(
        (issue) =>
          issue.code === "track.overlap" &&
          issue.entityIds.includes("pit-module-2"),
      ),
    ).toBe(true);
  });
  it("round-trips modular paths with boxes, zones and attachment IDs", () => {
    const document = modularPitFixture();
    document.pitBoxes.push({
      id: "box",
      pathId: "pit",
      distanceMeters: 30,
      lateralOffsetMeters: 0,
      order: 1,
      speedLimitKph: 60,
    });
    document.zones.push({
      id: "limit",
      pathId: "pit",
      type: "pit-speed-limit",
      startMeters: 12,
      endMeters: 50,
      properties: { speedLimitKph: 60 },
    });
    expect(parseDocument(serializeDocument(document))).toEqual(document);
    expect(attachPitEndpoints(document, "pit").paths[1].entryMarkerId).toBe(
      document.paths[1].entryMarkerId,
    );
  });
  it("preserves legacy geometry until an explicit reversible rebuild", () => {
    const document = createSampleDocument();
    document.paths.push({
      id: "old-pit",
      kind: "pit",
      closed: false,
      widthMeters: 6,
      sourceModuleIds: [],
      controlPoints: [
        createControlPoint({ x: -30, y: -20 }),
        createControlPoint({ x: 30, y: -20 }),
      ],
    });
    const restored = parseDocument(serializeDocument(document));
    expect(pitPathId(restored)).toBe("old-pit");
    expect(
      buildPathGeometry(restored, "old-pit")?.path.totalLengthMeters,
    ).toBeCloseTo(60);
    const rebuilt = rebuildPitWithModules(restored, "old-pit");
    expect(rebuilt.paths[1].controlPoints).toBeUndefined();
    expect(restored.paths[1].controlPoints).toHaveLength(2);
  });
});
