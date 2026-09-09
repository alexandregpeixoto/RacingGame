import type { TrackDocument } from "./domain/track/types";
import { parseTrackDocument } from "./domain/track/schema";
const DATABASE = "racing-game-track-creator";
const STORE = "tracks";
const LAST_DOCUMENT = "track-creator.last-document";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("Local storage is unavailable in this browser."));
      return;
    }
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore(STORE, { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(
        new Error("Close other Track Creator tabs to upgrade local storage."),
      );
  });
}
export async function saveDocument(document: TrackDocument): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE, "readwrite");
      transaction.objectStore(STORE).put(document);
      transaction.oncomplete = () => resolve();
      transaction.onabort = () =>
        reject(transaction.error ?? new Error("Save was aborted."));
      transaction.onerror = () => reject(transaction.error);
    });
    localStorage.setItem(LAST_DOCUMENT, document.id);
  } finally {
    database.close();
  }
}
export async function loadDocument(
  id: string,
): Promise<TrackDocument | undefined> {
  const database = await openDatabase();
  try {
    const value = await new Promise<unknown>((resolve, reject) => {
      const request = database
        .transaction(STORE, "readonly")
        .objectStore(STORE)
        .get(id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return value === undefined ? undefined : parseTrackDocument(value);
  } finally {
    database.close();
  }
}
export async function listDocuments(): Promise<
  Array<{ id: string; name: string }>
> {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = database
        .transaction(STORE, "readonly")
        .objectStore(STORE)
        .getAll();
      request.onsuccess = () =>
        resolve(
          request.result.map((value: TrackDocument) => ({
            id: value.id,
            name: value.metadata.name,
          })),
        );
      request.onerror = () => reject(request.error);
    });
  } finally {
    database.close();
  }
}
export async function loadLastDocument(): Promise<TrackDocument | undefined> {
  const id = localStorage.getItem(LAST_DOCUMENT);
  return id ? loadDocument(id) : undefined;
}
export function serializeDocument(document: TrackDocument): string {
  return JSON.stringify(document, null, 2);
}
export function parseDocument(text: string): TrackDocument {
  return parseTrackDocument(JSON.parse(text));
}
export function downloadDocument(track: TrackDocument): void {
  const blob = new Blob([serializeDocument(track)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = window.document.createElement("a");
  anchor.href = url;
  anchor.download =
    (track.metadata.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase() ||
      "track") + ".track.json";
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
