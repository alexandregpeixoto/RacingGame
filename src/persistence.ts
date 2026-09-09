import type { TrackDocument } from "./domain/track/types";
import { z } from "zod";
import { hydrateDocument } from "./domain/track/document";

const DATABASE = "racing-game-track-creator";
const STORE = "tracks";

const TrackDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  metadata: z.object({ name: z.string(), description: z.string(), createdAt: z.string(), updatedAt: z.string() }),
  world: z.object({ units: z.literal("meters"), upAxis: z.literal("z") }),
  modules: z.array(z.unknown()),
  connections: z.array(z.unknown()),
  paths: z.array(z.unknown()),
  markers: z.array(z.unknown()),
  zones: z.array(z.unknown()),
  grid: z.unknown(),
  spectatorFrame: z.unknown(),
  theme: z.unknown(),
  overrides: z.array(z.unknown()),
  props: z.array(z.unknown()).optional(),
  environment: z.unknown().optional(),
  pitBoxes: z.array(z.unknown()).optional(),
}).passthrough();

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveDocument(document: TrackDocument): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const request = database.transaction(STORE, "readwrite").objectStore(STORE).put(document);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
  database.close();
}

export async function loadDocument(id: string): Promise<TrackDocument | undefined> {
  if (typeof indexedDB === "undefined") return undefined;
  const database = await openDatabase();
  const document = await new Promise<TrackDocument | undefined>((resolve, reject) => {
    const request = database.transaction(STORE, "readonly").objectStore(STORE).get(id);
    request.onsuccess = () => resolve(request.result as TrackDocument | undefined);
    request.onerror = () => reject(request.error);
  });
  database.close();
  return document;
}

export function serializeDocument(document: TrackDocument): string {
  return JSON.stringify(document, null, 2);
}

export function parseDocument(text: string): TrackDocument {
  const parsed: unknown = JSON.parse(text);
  const result = TrackDocumentSchema.safeParse(parsed);
  if (!result.success) throw new Error("Invalid or unsupported track document.");
  return hydrateDocument(result.data as unknown as TrackDocument);
}

export function downloadDocument(track: TrackDocument): void {
  const blob = new Blob([serializeDocument(track)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = window.document.createElement("a");
  anchor.href = url;
  anchor.download = `${track.metadata.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "track"}.track.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}
