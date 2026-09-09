import type { TrackDocument } from "./types";

export interface EditorCommand {
  label: string;
  apply(document: TrackDocument): TrackDocument;
  undo(document: TrackDocument): TrackDocument;
  affectedEntityIds: string[];
}

export function snapshotCommand(label: string, before: TrackDocument, after: TrackDocument, affectedEntityIds: string[] = []): EditorCommand {
  return {
    label,
    affectedEntityIds,
    apply: () => structuredClone(after),
    undo: () => structuredClone(before),
  };
}
