# Track Creator

Desktop-first 2D track authoring foundation for the spectator racing simulator.

## Run

```bash
npm install
npm run dev
```

The editor starts with a valid sample oval. Documents are autosaved to IndexedDB and can be exported as versioned `.track.json` files.

## Implemented foundations

- Parametric straight and circular-arc modules with connector graph and snapping.
- Closed-loop centerline, width-aware boundaries, collision geometry, distance queries, and diagnostics.
- Independent Bézier Racing Line and open Bézier Pit Path editing.
- Generic semantic markers, timing zones, DRS zones, pit boxes, and category-neutral starting grid.
- Fixed spectator frame with fit/overflow validation.
- Elevation deltas, grade warnings, terrain heightmap sculpting, smoothing/flattening, and track/terrain following operations.
- Procedural Canvas2D rendering with realistic/cartoon themes and local module surface overrides.
- Props, barriers, runoff, kerbs, deterministic centerline ghost testing, and command-style grouped undo/redo.
- Runtime-validated, backward-compatible JSON import/export and IndexedDB persistence.

## Verification

```bash
npm run build
npm test
npx playwright test --list
```

Unit tests cover geometry, validation, terrain/document extensions, and persistence migration. The browser test is in `tests/e2e/track-creator.spec.ts`.
