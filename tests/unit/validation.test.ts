import { describe, expect, it } from "vitest";
import { createControlPoint, createEmptyDocument, createSampleDocument } from "../../src/domain/track/document";
import { validateDocument } from "../../src/domain/track/validation";

describe("track validation extensions", () => {
  it("requires a pit path when pit markers are authored", () => {
    const document = createSampleDocument();
    document.markers.push({ id: "pit-entry", type: "pit-entry", location: { pathId: "primary", distanceMeters: 20 }, configuration: {} });
    const report = validateDocument(document);
    expect(report.issues.some((item) => item.code === "pit.path-missing")).toBe(true);
  });

  it("accepts a valid racing line and terrain document extension", () => {
    const document = createSampleDocument();
    document.paths.push({ id: "racing-line", kind: "racing-line", closed: true, sourceModuleIds: [], widthMeters: 1.4, controlPoints: [createControlPoint({ x: -30, y: 3 }), createControlPoint({ x: 30, y: 3 }), createControlPoint({ x: 30, y: 57 }), createControlPoint({ x: -30, y: 57 })] });
    const report = validateDocument(document);
    expect(report.issues.some((item) => item.code === "path.control-points")).toBe(false);
    expect(document.terrain?.elevations).toHaveLength((document.terrain?.width ?? 0) * (document.terrain?.height ?? 0));
  });

  it("flags invalid terrain storage", () => {
    const document = createEmptyDocument();
    document.terrain!.elevations.pop();
    expect(validateDocument(document).issues.some((item) => item.code === "terrain.size")).toBe(true);
  });
});
