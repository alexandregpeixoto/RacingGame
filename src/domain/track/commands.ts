import type { TrackDocument } from "./types";

export interface EditorCommand {
  label: string;
  apply(document: TrackDocument): TrackDocument;
  undo(document: TrackDocument): TrackDocument;
  affectedEntityIds: string[];
}

export function snapshotCommand(
  label: string,
  before: TrackDocument,
  after: TrackDocument,
  affectedEntityIds: string[] = [],
): EditorCommand {
  const previous = structuredClone(before);
  const next = structuredClone(after);
  return {
    label,
    affectedEntityIds: [...affectedEntityIds],
    apply: () => structuredClone(next),
    undo: () => structuredClone(previous),
  };
}
