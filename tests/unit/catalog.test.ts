import { describe, it, expect } from "vitest";
import {
  CATALOG,
  DEFAULT_CATALOG_SETTINGS,
  placeCatalogEntity,
  pitSections,
  editPitSection,
  resolvedFacility,
} from "../../src/domain/track/catalog";
import {
  MODULE_DEFINITIONS,
  createModuleGeometry,
  moduleParameterErrors,
} from "../../src/domain/track/modules";
import {
  buildModulePath,
  buildModulePaths,
  buildPathGeometry,
  connectorsCompatible,
  getWorldConnector,
  inferRouteTraversals,
  modulesOverlap,
  snapModuleToOpenConnector,
  connectMatchingConnectors,
} from "../../src/domain/track/geometry";
import {
  createEmptyDocument,
  createSampleDocument,
} from "../../src/domain/track/document";
import { parseTrackDocument } from "../../src/domain/track/schema";
import { validateDocument } from "../../src/domain/track/validation";
import {
  createGhost,
  stepGhost,
  ghostPosition,
} from "../../src/domain/track/ghost";
import {
  changeFrameRatio,
  resizeFrame,
  fitSpectatorFrame,
  insideSpectatorFrame,
} from "../../src/domain/track/authoring";
import { raceCameraLayout } from "../../src/editor/raceCamera";
import type { TrackModule } from "../../src/domain/track/types";

const module = (
  definitionId: string,
  parameters: Record<string, number> = {},
): TrackModule => ({
  id: "test",
  definitionId,
  parameters,
  transform: { position: { x: 0, y: 0, z: 0 }, rotation: 0 },
});

describe("complete module catalog", () => {
  it("exposes exactly 50 implemented catalog entries with unique IDs", () => {
    expect(CATALOG).toHaveLength(50);
    expect(new Set(CATALOG.map((e) => e.id)).size).toBe(50);
  });
  for (const definition of MODULE_DEFINITIONS)
    it(`${definition.label}: finite geometry, connectors, surfaces and defaults`, () => {
      const road = module(definition.id, definition.defaultParameters),
        geometry = createModuleGeometry(road.definitionId, road.parameters)!;
      expect(moduleParameterErrors(road)).toEqual([]);
      expect(geometry.traversals!.length).toBeGreaterThan(0);
      for (const path of buildModulePaths(road)) {
        expect(path.totalLengthMeters).toBeGreaterThan(1);
        for (const sample of path.samples) {
          expect(Object.values(sample.position).every(Number.isFinite)).toBe(
            true,
          );
          expect(sample.curvature).toBeGreaterThanOrEqual(0);
          expect(sample.leftWidth).toBeGreaterThan(0);
          expect(sample.rightWidth).toBeGreaterThan(0);
        }
        expect(path.drivablePolygons.length).toBeGreaterThan(0);
      }
      for (const route of geometry.traversals!) {
        for (const axis of ["x", "y", "z"] as const) {
          expect(
            geometry.connectors.find((c) => c.id === route.entry)!.position[
              axis
            ],
          ).toBeCloseTo(route.curve.evaluate(0)[axis], 8);
          expect(
            geometry.connectors.find((c) => c.id === route.exit)!.position[
              axis
            ],
          ).toBeCloseTo(route.curve.evaluate(1)[axis], 8);
        }
      }
      const document = createEmptyDocument();
      document.modules.push(road);
      document.paths[0].sourceModuleIds.push(road.id);
      expect(
        validateDocument(document).issues.filter(
          (i) => i.code === "module.self-intersection",
        ),
      ).toEqual([]);
    });
  for (const family of [
    "s-curve",
    "chicane",
    "double-apex",
    "compound",
    "increasing-radius",
    "decreasing-radius",
    "switchback",
  ])
    it(`${family} mirrors without reversing forward travel`, () => {
      const a = createModuleGeometry(family + "-left", {})!.curve,
        b = createModuleGeometry(family + "-right", {})!.curve;
      for (const t of [0, 0.2, 0.6, 1]) {
        expect(a.evaluate(t).x).toBeCloseTo(b.evaluate(t).x, 8);
        expect(a.evaluate(t).y).toBeCloseTo(-b.evaluate(t).y, 8);
      }
    });
  it("progressive corners have monotonic curvature and double-apex has two peaks", () => {
    const open = createModuleGeometry("increasing-radius-left", {})!.curve;
    expect(open.curvature(0.15)).toBeGreaterThan(open.curvature(0.8));
    const tight = createModuleGeometry("decreasing-radius-left", {})!.curve;
    expect(tight.curvature(0.15)).toBeLessThan(tight.curvature(0.8));
    const double = createModuleGeometry("double-apex-left", {})!.curve;
    expect(double.curvature(0.25)).toBeGreaterThan(double.curvature(0.5));
    expect(double.curvature(0.75)).toBeGreaterThan(double.curvature(0.5));
  });
  it("generates asymmetric boundaries and swaps them on route reversal", () => {
    const document = createEmptyDocument(),
      road = module("asymmetric-transition", {
        leftStart: 3,
        rightStart: 5,
        leftEnd: 8,
        rightEnd: 4,
      });
    document.modules.push(road);
    document.paths.push({
      id: "reverse",
      kind: "secondary",
      closed: false,
      sourceModuleIds: [road.id],
      traversals: [{ moduleId: road.id, traversalId: "main", reversed: true }],
    });
    const path = buildPathGeometry(document, "reverse")!.path;
    expect(path.samples[0].leftWidth).toBe(4);
    expect(path.samples[0].rightWidth).toBe(8);
    expect(path.samples.at(-1)!.leftWidth).toBe(5);
  });
  it("snaps a non-origin connector with the correct transformed position", () => {
    const document = createEmptyDocument(),
      target = module("straight", { length: 40, width: 10 });
    target.id = "target";
    document.modules.push(target);
    document.paths[0].sourceModuleIds.push(target.id);
    const road = module("straight", { length: 20, width: 10 });
    road.transform.position.x = 20.01;
    const snapped = snapModuleToOpenConnector(
      document,
      road,
      1,
      "primary",
      "end",
    );
    expect(snapped.connection).toBeDefined();
    expect(
      connectorsCompatible(
        getWorldConnector(target, "end")!,
        getWorldConnector(snapped.module, "end")!,
      ),
    ).toBe(true);
  });
  it("shares junctions between explicit routes without changing the primary lap", () => {
    let document = createSampleDocument();
    document.modules[0].definitionId = "track-split";
    const primary = buildPathGeometry(document, "primary")!;
    document.paths[0].traversals = inferRouteTraversals(
      document,
      document.paths[0],
    );
    document.paths.push({
      id: "branch",
      kind: "secondary",
      closed: false,
      sourceModuleIds: ["m-bottom"],
      traversals: [
        { moduleId: "m-bottom", traversalId: "branch", reversed: false },
      ],
    });
    const endpoint = getWorldConnector(document.modules[0], "branch")!,
      extension = module("straight");
    extension.id = "extension";
    extension.transform = {
      position: endpoint.position,
      rotation: endpoint.tangent,
    };
    document.modules.push(extension);
    document.paths[1].sourceModuleIds.push(extension.id);
    document.paths[1].traversals!.push({
      moduleId: extension.id,
      traversalId: "main",
      reversed: false,
    });
    document = connectMatchingConnectors(document);
    expect(buildPathGeometry(document, "branch")).toBeDefined();
    expect(
      buildPathGeometry(document, "primary")!.path.totalLengthMeters,
    ).toBeCloseTo(primary.path.totalLengthMeters);
    document.paths[1].traversals![0].traversalId = "missing";
    expect(buildPathGeometry(document, "branch")).toBeUndefined();
  });
  it("permits adequate bridge clearance but rejects unmarked at-grade crossings", () => {
    const bridge = module("overpass"),
      crossing = module("straight", { length: 60, width: 10 });
    crossing.id = "cross";
    crossing.transform = {
      position: { x: 100, y: -30, z: 0 },
      rotation: Math.PI / 2,
    };
    expect(modulesOverlap(bridge, crossing)).toBe(false);
    expect(modulesOverlap(bridge, crossing, undefined, 7)).toBe(true);
    bridge.definitionId = "straight";
    bridge.parameters.length = 200;
    expect(modulesOverlap(bridge, crossing)).toBe(true);
    const document = createEmptyDocument();
    document.modules.push(module("crossover"));
    document.paths[0].sourceModuleIds.push("test");
    expect(
      validateDocument(document).issues.some(
        (i) => i.code === "crossing.at-grade" && i.severity === "warning",
      ),
    ).toBe(true);
  });
});

describe("semantic tools, migration and camera", () => {
  it("rejects incomplete garage metadata before it reaches the editor", () => {
    const document = createSampleDocument();
    document.props.push({
      id: "garage",
      type: "grandstand",
      position: { x: 0, y: 0, z: 0 },
      rotation: 0,
      scale: 1,
      properties: { facility: "pit-garage" },
    });
    expect(() => parseTrackDocument(document)).toThrow(/Pit garages/);
  });
  it("edits pit groups without losing IDs/order and keeps garages path anchored", () => {
    let document = createSampleDocument();
    const road = module("straight", { length: 120, width: 10 });
    road.id = "pit-road";
    road.transform.position.y = -50;
    document.modules.push(road);
    document.paths.push({
      id: "pit",
      kind: "pit",
      closed: false,
      sourceModuleIds: [road.id],
      widthMeters: 10,
      traversals: [{ moduleId: road.id, traversalId: "main", reversed: false }],
    });
    document = placeCatalogEntity(
      document,
      "pit-box-section",
      "pit",
      { x: 0, y: -50 },
      { ...DEFAULT_CATALOG_SETTINGS, count: 3, spacing: 10 },
    );
    const firstGroup = pitSections(document)[0].id,
      original = document.pitBoxes.map((b) => ({ id: b.id, order: b.order }));
    document = placeCatalogEntity(
      document,
      "pit-box-section",
      "pit",
      { x: 50, y: -50 },
      { ...DEFAULT_CATALOG_SETTINGS, count: 2, spacing: 10 },
    );
    document = editPitSection(document, firstGroup, { count: 4 });
    for (const before of original)
      expect(document.pitBoxes.find((b) => b.id === before.id)?.order).toBe(
        before.order,
      );
    expect(new Set(document.pitBoxes.map((b) => b.order)).size).toBe(
      document.pitBoxes.length,
    );
    expect(
      parseTrackDocument(JSON.parse(JSON.stringify(document))).pitBoxes,
    ).toEqual(document.pitBoxes);
    document = placeCatalogEntity(
      document,
      "pit-garage-section",
      "pit",
      { x: 0, y: -50 },
      { ...DEFAULT_CATALOG_SETTINGS, count: 3, spacing: 10, offset: -14 },
    );
    const before = resolvedFacility(document, document.props[0]).position.y;
    document.modules.find((m) => m.id === road.id)!.transform.position.y -= 20;
    expect(
      resolvedFacility(document, document.props[0]).position.y,
    ).toBeCloseTo(before - 20);
    const garages = pitSections(document).find(
      (s) => s.action === "pit-garage-section",
    )!;
    expect(editPitSection(document, garages.id, {}, true).props).toHaveLength(
      0,
    );
  });
  it("links pit speed-line start/end roles to one zone", () => {
    let document = createEmptyDocument();
    const road = module("straight", { length: 120 });
    document.modules.push(road);
    document.paths.push({
      id: "pit",
      kind: "pit",
      closed: false,
      sourceModuleIds: [road.id],
      widthMeters: 10,
      traversals: [{ moduleId: road.id, traversalId: "main", reversed: false }],
    });
    document = placeCatalogEntity(
      document,
      "pit-speed-line",
      "pit",
      { x: 10, y: 0 },
      DEFAULT_CATALOG_SETTINGS,
    );
    document = placeCatalogEntity(
      document,
      "pit-speed-line",
      "pit",
      { x: 90, y: 0 },
      {
        ...DEFAULT_CATALOG_SETTINGS,
        lineRole: "end",
        zoneId: document.zones[0].id,
      },
    );
    expect(document.zones).toHaveLength(1);
    expect(document.zones[0].endMeters).toBeCloseTo(90);
  });
  it("uses existing markers, grid and linked speed/DRS zones", () => {
    const point = { x: 0, y: 0 };
    let document = createSampleDocument();
    document = placeCatalogEntity(
      document,
      "start-finish",
      "primary",
      point,
      DEFAULT_CATALOG_SETTINGS,
    );
    expect(
      document.markers.filter((m) => m.type === "start-finish"),
    ).toHaveLength(1);
    document = placeCatalogEntity(
      document,
      "speed-limit-start",
      "primary",
      point,
      DEFAULT_CATALOG_SETTINGS,
    );
    const zoneId = document.zones[0].id;
    document = placeCatalogEntity(
      document,
      "speed-limit-end",
      "primary",
      { x: 20, y: 0 },
      { ...DEFAULT_CATALOG_SETTINGS, zoneId },
    );
    expect(document.zones).toHaveLength(1);
    expect(document.zones[0].endMeters).toBeCloseTo(60);
    document = placeCatalogEntity(
      document,
      "drs-activation",
      "primary",
      point,
      DEFAULT_CATALOG_SETTINGS,
    );
    document = placeCatalogEntity(document, "drs-detection", "primary", point, {
      ...DEFAULT_CATALOG_SETTINGS,
      zoneId: document.zones[1].id,
    });
    expect(document.markers.at(-1)!.configuration.zoneId).toBe(
      document.zones[1].id,
    );
  });
  it("migrates legacy frames without cropping and preserves new route documents", () => {
    const legacy = createSampleDocument();
    legacy.schemaVersion = 1;
    delete legacy.spectatorFrame.aspectRatio;
    legacy.spectatorFrame.size = { x: 120, y: 120 };
    const migrated = parseTrackDocument(legacy);
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.paths[0].traversals).toHaveLength(4);
    expect(migrated.spectatorFrame.size.x).toBeCloseTo((120 * 16) / 9);
    expect(migrated.spectatorFrame.center).toEqual(
      legacy.spectatorFrame.center,
    );
    expect(parseTrackDocument(JSON.parse(JSON.stringify(migrated)))).toEqual(
      migrated,
    );
    migrated.spectatorFrame.size.x = 12;
    expect(() => parseTrackDocument(migrated)).toThrow(/aspect ratio/);
  });
  it("fits rotated margins at a fixed ratio and produces centered letterboxing", () => {
    let frame = createSampleDocument().spectatorFrame;
    frame.rotation = 0.6;
    const points = [
      { x: -100, y: -30 },
      { x: 80, y: 20 },
    ];
    frame = fitSpectatorFrame(frame, points);
    expect(points.every((p) => insideSpectatorFrame(frame, p))).toBe(true);
    expect(frame.size.x / frame.size.y).toBeCloseTo(16 / 9);
    const square = changeFrameRatio(frame, { x: 1, y: 1 });
    expect(square.size.y).toBeGreaterThanOrEqual(frame.size.y);
    const close = resizeFrame(frame, frame.size.x / 3);
    expect(points.every((p) => insideSpectatorFrame(close, p))).toBe(false);
    for (const [w, h] of [
      [1000, 1000],
      [1800, 700],
    ]) {
      const layout = raceCameraLayout(frame, w, h);
      expect(layout.rect.width / layout.rect.height).toBeCloseTo(16 / 9);
      expect(layout.rect.y).toBeGreaterThanOrEqual(60);
      expect(layout.rect.height).toBeLessThanOrEqual(h - 100);
    }
  });
  it("stops open-route ghosts and reports zones deterministically", () => {
    const path = buildModulePath(module("straight", { length: 60 })),
      zones = [
        {
          id: "limit",
          type: "speed-limit",
          pathId: "open",
          startMeters: 10,
          endMeters: 50,
          properties: {},
        },
      ];
    const run = () =>
      stepGhost(createGhost(), path, [], "open", 1000, 0, zones);
    expect(run()).toEqual(run());
    expect(run().events.map((e) => e.type)).toEqual([
      "speed-limit entry",
      "speed-limit exit",
    ]);
    expect(ghostPosition(run(), path).progress).toBe(1);
    expect(stepGhost(run(), path, [], "open", 1000, 0, zones)).toEqual(run());
  });
});
