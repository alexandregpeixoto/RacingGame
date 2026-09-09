import { describe, expect, it } from "vitest";
import { createSampleDocument } from "../../src/domain/track/document";
import { parseDocument, serializeDocument } from "../../src/persistence";

describe("track persistence", () => {
  it("round-trips a versioned document", () => {
    const document = createSampleDocument();
    const parsed = parseDocument(serializeDocument(document));
    expect(parsed.id).toBe(document.id);
    expect(parsed.modules).toHaveLength(document.modules.length);
  });

  it("rejects unsupported documents", () => {
    expect(() => parseDocument(JSON.stringify({ schemaVersion: 99 }))).toThrow(
      "Invalid or unsupported track document",
    );
  });

  it("hydrates version-one documents created before terrain and props were added", () => {
    const document = createSampleDocument();
    const legacy = { ...document } as Record<string, unknown>;
    delete legacy.terrain;
    delete legacy.props;
    delete legacy.environment;
    delete legacy.pitBoxes;
    const restored = parseDocument(JSON.stringify(legacy));
    expect(restored.terrain?.elevations.length).toBeGreaterThan(0);
    expect(restored.props).toEqual([]);
    expect(restored.pitBoxes).toEqual([]);
  });
});
