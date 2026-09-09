import { z } from "zod";
import type { TrackDocument } from "./types";
import { hydrateDocument } from "./document";
import { getModuleDefinition } from "./modules";
import { inferRouteTraversals } from "./geometry";

const number = z.number().finite();
const positive = number.positive();
const id = z.string().min(1);
const vec2 = z.object({ x: number, y: number });
const vec3 = vec2.extend({ z: number });
const controlPoint = z.object({
  id,
  position: vec3,
  inHandle: vec2,
  outHandle: vec2,
});
const values = z.record(z.string(), z.union([z.string(), number, z.boolean()]));
const properties = z.object({
  surface: z
    .enum(["asphalt", "concrete", "gravel", "sand", "grass"])
    .optional(),
  grip: positive.optional(),
  widthMeters: positive.optional(),
  kerb: z.enum(["none", "red-white", "blue-white"]).optional(),
});
const connector = z.object({
  moduleId: id,
  connectorId: id,
});
export const TrackDocumentSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  minimumClearanceMeters: positive.optional(),
  id,
  metadata: z.object({
    name: z.string(),
    description: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
  world: z.object({ units: z.literal("meters"), upAxis: z.literal("z") }),
  modules: z.array(
    z.object({
      id,
      definitionId: id.refine(
        (value) => Boolean(getModuleDefinition(value)),
        "Unknown module definition",
      ),
      transform: z.object({ position: vec3, rotation: number }),
      parameters: z.record(z.string(), number),
      controlPoints: z.array(controlPoint).min(2).max(128).optional(),
      properties: properties.optional(),
    }),
  ),
  connections: z.array(z.object({ id, a: connector, b: connector })),
  paths: z.array(
    z.object({
      id,
      kind: z.enum(["primary-loop", "secondary", "racing-line", "pit"]),
      closed: z.boolean(),
      sourceModuleIds: z.array(id).default([]),
      traversals: z
        .array(
          z.object({ moduleId: id, traversalId: id, reversed: z.boolean() }),
        )
        .optional(),
      entryMarkerId: id.optional(),
      exitMarkerId: id.optional(),
      widthMeters: positive.optional(),
      metadata: values.optional(),
      controlPoints: z
        .array(
          z.object({ id, position: vec3, inHandle: vec2, outHandle: vec2 }),
        )
        .optional(),
    }),
  ),
  markers: z.array(
    z.object({
      id,
      type: z.enum([
        "start-finish",
        "pit-entry",
        "pit-exit",
        "sector",
        "checkpoint",
        "timing-line",
        "speed-trap",
      ]),
      location: z.object({
        pathId: id,
        distanceMeters: number,
        anchor: z
          .object({ moduleId: id, localT: number, traversalId: id.optional() })
          .optional(),
      }),
      configuration: values,
    }),
  ),
  zones: z
    .array(
      z.object({
        id,
        type: id,
        pathId: id,
        startMeters: number,
        endMeters: number,
        properties: values,
      }),
    )
    .default([]),
  grid: z.object({
    pathId: id,
    startMarkerId: z.string(),
    slotCount: number.int().min(1).max(1000),
    longitudinalSpacingMeters: positive,
    lateralSpacingMeters: number.nonnegative(),
    staggerPattern: z.enum(["none", "alternating", "custom"]),
    slots: z.array(
      z.object({
        slot: number.int().min(1),
        distanceOffsetMeters: number.optional(),
        lateralOffsetMeters: number.optional(),
      }),
    ),
  }),
  spectatorFrame: z.object({
    aspectRatio: z.object({ x: positive, y: positive }).optional(),
    center: vec2,
    size: z.object({ x: positive, y: positive }),
    rotation: number,
    margins: z.object({
      top: number.nonnegative(),
      right: number.nonnegative(),
      bottom: number.nonnegative(),
      left: number.nonnegative(),
    }),
    required: z.boolean(),
  }),
  theme: z.object({ id, name: z.string() }),
  overrides: z.array(z.object({ id, targetId: id, values: properties })),
  terrain: z
    .object({
      width: number.int().min(1).max(512),
      height: number.int().min(1).max(512),
      cellSizeMeters: positive,
      origin: vec2,
      elevations: z.array(number).max(512 * 512),
    })
    .refine(
      (terrain) => terrain.elevations.length === terrain.width * terrain.height,
      "Terrain dimensions do not match elevation data",
    )
    .optional(),
  props: z
    .array(
      z
        .object({
          id,
          type: z.enum([
            "tree",
            "light",
            "barrier",
            "grandstand",
            "marshal-post",
            "sign",
          ]),
          position: vec3,
          rotation: number,
          scale: positive,
          properties: values,
        })
        .refine(
          (prop) =>
            prop.properties.facility !== "pit-garage" ||
            (typeof prop.properties.group === "string" &&
              prop.properties.group.length > 0 &&
              typeof prop.properties.pathId === "string" &&
              prop.properties.pathId.length > 0 &&
              typeof prop.properties.distanceMeters === "number" &&
              prop.properties.distanceMeters >= 0 &&
              typeof prop.properties.offset === "number"),
          "Pit garages require a section ID, path ID, distance and lateral offset",
        ),
    )
    .default([]),
  environment: z
    .object({
      runoff: z.enum(["grass", "gravel", "sand", "asphalt", "concrete"]),
      barrier: z.enum(["none", "guardrail", "wall", "tire-stack", "fence"]),
      kerb: z.enum(["none", "red-white", "blue-white", "yellow-black"]),
    })
    .default({ runoff: "grass", barrier: "guardrail", kerb: "red-white" }),
  pitBoxes: z
    .array(
      z.object({
        sectionId: id.optional(),
        id,
        pathId: id,
        distanceMeters: number,
        lateralOffsetMeters: number,
        order: number.int().positive(),
        speedLimitKph: positive,
      }),
    )
    .default([]),
});

// Migration entry point: v1 files predating optional extensions are hydrated here.
// Semantic errors (e.g. an open track under construction) remain editable.
export function parseTrackDocument(value: unknown): TrackDocument {
  const result = TrackDocumentSchema.safeParse(value);
  if (!result.success) {
    const detail = result.error.issues[0];
    throw new Error(
      "Invalid or unsupported track document: " +
        detail.path.join(".") +
        " " +
        detail.message,
    );
  }
  const document = hydrateDocument(result.data);
  if (document.schemaVersion === 1) {
    for (const path of document.paths) {
      if (path.sourceModuleIds.length && !path.traversals)
        path.traversals = inferRouteTraversals(document, path);
    }
    document.schemaVersion = 2;
  }
  const frame = document.spectatorFrame;
  if (!frame.aspectRatio) {
    frame.aspectRatio = { x: 16, y: 9 };
    const width = Math.max(frame.size.x, (frame.size.y * 16) / 9);
    frame.size = { x: width, y: (width * 9) / 16 };
  } else if (
    Math.abs(
      frame.size.x / frame.size.y - frame.aspectRatio.x / frame.aspectRatio.y,
    ) > 1e-6
  ) {
    throw new Error("Frame coverage does not match its aspect ratio.");
  }
  const ids = [
    ...document.modules,
    ...document.connections,
    ...document.paths,
    ...document.markers,
    ...document.zones,
    ...document.props,
    ...document.pitBoxes,
    ...document.overrides,
    ...document.paths.flatMap((path) => path.controlPoints ?? []),
  ].map((item) => item.id);
  if (new Set(ids).size !== ids.length)
    throw new Error(
      "Invalid or unsupported track document: duplicate entity IDs.",
    );
  return document;
}
