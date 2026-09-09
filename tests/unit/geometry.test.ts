import { describe, expect, it } from "vitest";
import { buildControlPointPath, buildPrimaryPath, getWorldConnector, snapModuleToOpenConnector } from "../../src/domain/track/geometry";
import { createControlPoint, createSampleDocument } from "../../src/domain/track/document";
import { validateDocument } from "../../src/domain/track/validation";
import type { TrackModule } from "../../src/domain/track/types";

describe("track geometry", () => {
  it("builds a continuous closed sample loop", () => {
    const document = createSampleDocument();
    const path = buildPrimaryPath(document);
    expect(path).toBeDefined();
    expect(path!.totalLengthMeters).toBeGreaterThan(200);
    expect(path!.positionAtDistance(0).x).toBeCloseTo(path!.positionAtDistance(path!.totalLengthMeters).x, 1);
  });

  it("wraps distance around a closed path", () => {
    const path = buildPrimaryPath(createSampleDocument())!;
    expect(path.wrapDistance(path.totalLengthMeters + 12)).toBeCloseTo(12);
    expect(path.wrapDistance(-12)).toBeCloseTo(path.totalLengthMeters - 12);
  });

  it("reports a valid sample document", () => {
    const report = validateDocument(createSampleDocument());
    expect(report.valid).toBe(true);
    expect(report.issues.filter((item) => item.severity === "error")).toHaveLength(0);
  });

  it("snaps a compatible module to an open connector", () => {
    const document = createSampleDocument();
    const module: TrackModule = { id: "new", definitionId: "straight", transform: { position: { x: -40, y: 0, z: 0 }, rotation: 0 }, parameters: { length: 40, width: 10, elevationDelta: 0 } };
    const connector = getWorldConnector(document.modules[0], "start")!;
    const result = snapModuleToOpenConnector({ ...document, modules: document.modules.slice(0, 1), connections: [] }, module, 2);
    expect(result.module.transform.position.x).toBeCloseTo(connector.position.x);
    expect(result.connection).toBeDefined();
  });

  it("samples a closed cubic path independently from the circuit centerline", () => {
    const points = [createControlPoint({ x: 0, y: 0 }), createControlPoint({ x: 40, y: 0 }), createControlPoint({ x: 40, y: 30 }), createControlPoint({ x: 0, y: 30 })];
    const path = buildControlPointPath({ id: "racing-line", kind: "racing-line", closed: true, sourceModuleIds: [], widthMeters: 1.4, controlPoints: points });
    expect(path).toBeDefined();
    expect(path!.totalLengthMeters).toBeGreaterThan(100);
    expect(path!.wrapDistance(path!.totalLengthMeters + 5)).toBeCloseTo(5);
  });
});
