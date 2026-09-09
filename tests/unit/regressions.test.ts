import { describe, expect, it } from "vitest";
import {
  createControlPoint,
  createEmptyDocument,
  createSampleDocument,
  createTerrain,
} from "../../src/domain/track/document";
import {
  buildPrimaryPath,
  buildModulePath,
  buildControlPointPath,
  buildPathGeometry,
  connectMatchingConnectors,
  connectorsCompatible,
  getWorldConnector,
  modulesOverlap,
  reconcileMarkerAnchors,
  snapModuleToOpenConnector,
  CubicBezierCurve,
} from "../../src/domain/track/geometry";
import { createModuleGeometry } from "../../src/domain/track/modules";
import {
  diagnostics,
  validateDocument,
} from "../../src/domain/track/validation";
import {
  generateGrid,
  fitSpectatorFrame,
  insideSpectatorFrame,
} from "../../src/domain/track/authoring";
import { parseDocument, serializeDocument } from "../../src/persistence";
import {
  createGhost,
  ghostPosition,
  stepGhost,
} from "../../src/domain/track/ghost";
import { snapshotCommand } from "../../src/domain/track/commands";
import {
  terrainHeightAt,
  trackFollowingTerrain,
  terrainFollowingTrack,
} from "../../src/domain/track/terrain";

describe("geometry regressions from the original scope audit", () => {
  it("turns right while entering in the forward direction, including elevation", () => {
    const right = createModuleGeometry("curve-right", {
      radius: 30,
      angle: Math.PI / 2,
      width: 10,
      elevationDelta: 10,
    })!;
    expect(right.curve.evaluate(1)).toEqual({
      x: 30,
      y: expect.closeTo(-30),
      z: 10,
    });
    expect(right.curve.tangent(0).x).toBeGreaterThan(0);
    expect(right.curve.tangent(1).y).toBeLessThan(0);
    expect(right.curve.length()).toBeCloseTo(
      Math.hypot((30 * Math.PI) / 2, 10),
    );
    expect(right.connectors[1].position).toEqual(right.curve.evaluate(1));
  });
  it("uses exact analytical module lengths and interpolates nearest positions", () => {
    const path = buildPrimaryPath(createSampleDocument())!;
    expect(path.totalLengthMeters).toBeCloseTo(160 + 60 * Math.PI, 8);
    const projection = path.nearestPoint({ x: -27.123, y: 1 });
    expect(projection.position.x).toBeCloseTo(-27.123, 8);
    expect(projection.distanceMeters).toBeCloseTo(12.877, 8);
    expect(projection.localT).toBeCloseTo(12.877 / 80, 8);
    expect(path.sampleAtDistance(82).moduleId).toBe("m-right");
    expect(path.drivablePolygons.length).toBeGreaterThan(100);
  });
  it("uses spatial length and normalized tangents without shrinking horizontal boundaries", () => {
    const module = createSampleDocument().modules[0];
    module.parameters.elevationDelta = 60;
    const path = buildModulePath(module);
    expect(path.totalLengthMeters).toBe(100);
    const tangent = path.tangentAtDistance(50);
    expect(Math.hypot(tangent.x, tangent.y, tangent.z)).toBeCloseTo(1);
    expect(path.leftBoundary[0].y - path.rightBoundary[0].y).toBeCloseTo(10);
  });
  it("rejects physically separated, misoriented, unequal-width or reused connectors", () => {
    for (const change of ["position", "rotation", "width", "duplicate"]) {
      const document = createSampleDocument();
      if (change === "position") document.modules[1].transform.position.x += 1;
      if (change === "rotation") document.modules[1].transform.rotation += 0.1;
      if (change === "width") document.modules[1].parameters.width = 12;
      if (change === "duplicate")
        document.connections.push({
          ...document.connections[0],
          id: "duplicate",
        });
      expect(buildPrimaryPath(document), change).toBeUndefined();
      expect(validateDocument(document).valid, change).toBe(false);
    }
  });
  it("requires explicit graph closure and respects path membership and ID", () => {
    const document = createSampleDocument();
    document.paths[0].id = "renamed-primary";
    expect(buildPathGeometry(document, "renamed-primary")).toBeDefined();
    document.connections.pop();
    expect(buildPrimaryPath(document)).toBeUndefined();
    const connected = connectMatchingConnectors(document);
    expect(connected.connections).toHaveLength(4);
    expect(buildPrimaryPath(connected)).toBeDefined();
    connected.paths[0].closed = false;
    expect(buildPrimaryPath(connected)).toBeUndefined();
  });
  it("enforces snapping width, elevation and tolerance", () => {
    const document = createSampleDocument();
    document.modules = [document.modules[0]];
    document.connections = [];
    const candidate = structuredClone(document.modules[0]);
    candidate.id = "candidate";
    candidate.transform.position.x = 40;
    expect(
      snapModuleToOpenConnector(document, candidate, 1).connection,
    ).toBeDefined();
    candidate.parameters.width = 11;
    expect(
      snapModuleToOpenConnector(document, candidate, 1).connection,
    ).toBeUndefined();
    candidate.parameters.width = 10;
    candidate.transform.position.z = 2;
    expect(
      snapModuleToOpenConnector(document, candidate, 1).connection,
    ).toBeUndefined();
    candidate.transform.position.z = 0;
    candidate.transform.position.x = 42;
    expect(
      snapModuleToOpenConnector(document, candidate, 1).connection,
    ).toBeUndefined();
    const a = getWorldConnector(document.modules[0], "end")!;
    candidate.transform.position.x = 40;
    expect(
      connectorsCompatible(a, getWorldConnector(candidate, "start")!),
    ).toBe(true);
  });
  it("detects overlapping straight surfaces before a circuit is closed", () => {
    const document = createEmptyDocument();
    const a = structuredClone(createSampleDocument().modules[0]),
      b = structuredClone(a);
    b.id = "parallel";
    b.transform.position.y += 4;
    document.modules = [a, b];
    document.paths[0].sourceModuleIds = [a.id, b.id];
    expect(modulesOverlap(a, b)).toBe(true);
    expect(
      validateDocument(document).issues.some(
        (item) => item.code === "track.overlap",
      ),
    ).toBe(true);
    b.transform.position.y = 10;
    expect(modulesOverlap(a, b)).toBe(false);
  });
  it("clamps open pit paths instead of wrapping", () => {
    const path = buildControlPointPath({
      id: "pit",
      kind: "pit",
      closed: false,
      sourceModuleIds: [],
      controlPoints: [
        createControlPoint({ x: 0, y: 0 }),
        createControlPoint({ x: 30, y: 0 }),
      ],
    })!;
    expect(path.positionAtDistance(100).x).toBeCloseTo(30);
    expect(path.positionAtDistance(-5).x).toBe(0);
    expect(path.nearestPoint({ x: 12.123, y: 2 }).position.x).toBeCloseTo(
      12.123,
    );
  });
  it("measures Bezier curvature in inverse meters", () => {
    const curve = (scale: number) =>
      new CubicBezierCurve(
        { x: 0, y: 0, z: 0 },
        { x: 0, y: scale, z: 0 },
        { x: scale, y: scale, z: 0 },
        { x: scale, y: 0, z: 0 },
      );
    expect(curve(10).curvature(0.5) / curve(20).curvature(0.5)).toBeCloseTo(
      2,
      3,
    );
  });
});

describe("authored data and validation", () => {
  it.each([
    "modules",
    "connections",
    "paths",
    "markers",
    "grid",
    "spectatorFrame",
    "props",
    "terrain",
  ])("rejects malformed nested %s", (field) => {
    const document = JSON.parse(serializeDocument(createSampleDocument()));
    document[field] = [
      "modules",
      "connections",
      "paths",
      "markers",
      "props",
    ].includes(field)
      ? [null]
      : {};
    expect(() => parseDocument(JSON.stringify(document))).toThrow(
      "Invalid or unsupported",
    );
  });
  it("rejects duplicate IDs and preserves authored overrides through round-trip", () => {
    const document = createSampleDocument();
    document.overrides.push({
      id: "override",
      targetId: "m-bottom",
      values: { surface: "gravel", kerb: "none" },
    });
    expect(parseDocument(serializeDocument(document))).toEqual(document);
    document.modules[1].id = document.modules[0].id;
    expect(() => parseDocument(serializeDocument(document))).toThrow(
      "duplicate",
    );
  });
  it("diagnoses invalid curve parameters instead of silently accepting clamps", () => {
    const document = createSampleDocument();
    document.modules[1].parameters.radius = -10;
    expect(
      validateDocument(document).issues.some(
        (item) => item.code === "module.parameters",
      ),
    ).toBe(true);
  });
  it("preserves canonical marker distance when an anchor no longer resolves", () => {
    const document = createSampleDocument();
    document.markers[0].location.anchor!.moduleId = "deleted";
    expect(
      validateDocument(document).issues.some(
        (item) => item.code === "marker.anchor-unresolved",
      ),
    ).toBe(true);
    expect(document.markers[0].location.distanceMeters).toBe(0);
  });
  it("moves an anchored marker along its module when a valid circuit changes length", () => {
    const before = createSampleDocument();
    before.markers[0].location = {
      pathId: "primary",
      distanceMeters: 40,
      anchor: { moduleId: "m-bottom", localT: 0.5 },
    };
    const after = structuredClone(before);
    after.modules[0].parameters.length = 100;
    after.modules[2].parameters.length = 100;
    after.modules[1].transform.position.x += 20;
    after.modules[2].transform.position.x += 20;
    expect(
      reconcileMarkerAnchors(before, after).markers[0].location.distanceMeters,
    ).toBeCloseTo(50);
  });
  it("applies grid overrides and validates the generated positions", () => {
    const document = createSampleDocument();
    document.grid.slots = [
      { slot: 1, distanceOffsetMeters: 20, lateralOffsetMeters: 20 },
    ];
    const grid = generateGrid(document);
    expect(grid[0].position).toEqual({ x: -20, y: 20, z: 0 });
    expect(
      validateDocument(document).issues.some(
        (item) => item.code === "grid.outside",
      ),
    ).toBe(true);
    document.grid.startMarkerId = "";
    expect(generateGrid(document)).toEqual([]);
    expect(
      validateDocument(document).issues.some(
        (item) => item.code === "grid.start-missing",
      ),
    ).toBe(true);
  });
  it("honors rotated spectator frames and asymmetric margins", () => {
    const frame = createSampleDocument().spectatorFrame;
    frame.rotation = Math.PI / 4;
    frame.margins = { top: 12, right: 3, bottom: 5, left: 22 };
    const points = [
      { x: -40, y: -20 },
      { x: 80, y: 60 },
      { x: -60, y: 50 },
    ];
    const fitted = fitSpectatorFrame(frame, points);
    expect(points.every((point) => insideSpectatorFrame(fitted, point))).toBe(
      true,
    );
    // Aspect-ratio fitting can leave horizontal slack; shrink both axes to crop.
    fitted.size.x *= 0.8;
    fitted.size.y *= 0.8;
    expect(points.every((point) => insideSpectatorFrame(fitted, point))).toBe(
      false,
    );
  });
  it("allows wrapping zones on a circuit and requires pit endpoint reconnection", () => {
    const document = createSampleDocument();
    document.zones.push({
      id: "zone",
      type: "drs",
      pathId: "primary",
      startMeters: 300,
      endMeters: 20,
      properties: {},
    });
    expect(
      validateDocument(document).issues.some(
        (item) => item.code === "zone.range",
      ),
    ).toBe(false);
    document.paths.push({
      id: "pit",
      kind: "pit",
      closed: false,
      sourceModuleIds: [],
      widthMeters: 6,
      controlPoints: [
        createControlPoint({ x: 200, y: 200 }),
        createControlPoint({ x: 220, y: 200 }),
      ],
    });
    document.markers.push(
      ...(["pit-entry", "pit-exit"] as const).map((type) => ({
        id: type,
        type,
        location: { pathId: "primary", distanceMeters: 20 },
        configuration: {},
      })),
    );
    expect(
      validateDocument(document).issues.some(
        (item) => item.code === "pit.reconnection",
      ),
    ).toBe(true);
  });
  it("makes sectors cover the complete lap and centers the terrain grid", () => {
    const document = createSampleDocument(),
      stats = diagnostics(document);
    expect(
      stats.sectorLengths.reduce((sum, sector) => sum + sector.lengthMeters, 0),
    ).toBeCloseTo(stats.lapLengthMeters);
    const terrain = createTerrain();
    expect(
      terrain.origin.x + (terrain.width * terrain.cellSizeMeters) / 2,
    ).toBe(0);
  });
  it("isolates command snapshots from later mutations", () => {
    const before = createSampleDocument(),
      after = structuredClone(before);
    after.metadata.name = "After";
    const command = snapshotCommand("Rename", before, after);
    before.metadata.name = "Changed";
    after.metadata.name = "Changed";
    expect(command.apply(before).metadata.name).toBe("After");
    expect(command.undo(after).metadata.name).toBe("Starter Oval");
  });
});
describe("deterministic ghost", () => {
  it("produces identical lap progress and events regardless of frame grouping", () => {
    const document = createSampleDocument(),
      path = buildPrimaryPath(document)!;
    let sequential = createGhost();
    for (let i = 0; i < 2400; i++)
      sequential = stepGhost(sequential, path, document.markers, "primary");
    const batched = stepGhost(
      createGhost(),
      path,
      document.markers,
      "primary",
      2400,
    );
    expect(sequential).toEqual(batched);
    expect(ghostPosition(batched, path).lap).toBe(2);
    expect(batched.events.some((event) => event.type === "start-finish")).toBe(
      true,
    );
    expect(
      stepGhost(createGhost(), path, document.markers, "primary", 2400),
    ).toEqual(batched);
  });
});

describe("terrain coupling", () => {
  it("samples terrain smoothly and preserves connected endpoint elevations", () => {
    const document = createSampleDocument(),
      terrain = document.terrain!;
    terrain.elevations = terrain.elevations.map(
      (_, i) => (i % terrain.width) * 0.1,
    );
    expect(
      terrainHeightAt(terrain, {
        x: terrain.origin.x + terrain.cellSizeMeters,
        y: terrain.origin.y + 4,
      }),
    ).toBeCloseTo(0.05);
    const after = trackFollowingTerrain(document);
    expect(buildPrimaryPath(after)).toBeDefined();
    expect(after.modules[0].parameters.elevationDelta).not.toBe(0);
    expect(document.modules[0].parameters.elevationDelta).toBe(0);
  });
  it("applies track height to terrain cells beneath the full road", () => {
    const document = createSampleDocument();
    document.modules.forEach((module) => {
      module.transform.position.z = 5;
    });
    const after = terrainFollowingTrack(document);
    expect(
      after.terrain!.elevations.filter((height) => height === 5).length,
    ).toBeGreaterThan(40);
    expect(document.terrain!.elevations.every((height) => height === 0)).toBe(
      true,
    );
  });
});
