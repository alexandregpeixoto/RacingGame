# Original scope audit

Reviewed against the original “Browser-Based Spectator Racing Simulator — Track Creator Foundation” brief supplied on September 8, 2026. The original brief is a Track Creator specification with several explicitly future capabilities; it is not a request for the complete racing simulator.

## Assessment

The repository had a useful React/Canvas prototype and a framework-independent track model, but the claim that every roadmap phase was complete was too strong. Eleven unit tests and two UI smoke tests did not exercise the construction, recovery, validation, or transaction failures below.

The category-neutral model, independent centerline/Racing Line, world-space coordinates, and theme separation are appropriate foundations. This audit preserves that architecture and corrects verified behavior.

## Findings and corrections

| Area | Verified defect | Correction |
| --- | --- | --- |
| Local recovery | Startup generated a new ID and tried loading that ID, so reload never recovered the last edited track. | Store the last successfully saved ID, restore before autosaving, wait for IndexedDB transaction completion, surface errors, and provide an Open list. |
| Import | Modules, paths, grid, frame, and other nested fields used unknown schemas; malformed JSON could crash rendering. | Validate every nested entity, finite values, supported version, terrain dimensions, and unique entity IDs before replacing the document. Incomplete but structurally valid circuits remain editable. |
| Right curves | Negative arc angle also reversed travel, producing backward geometry and mismatched connector tangents. | Mirror the arc across the forward axis, retain forward entry direction, and calculate spatial arc length correctly. |
| Circuit closure | A connection record was enough even when connected pieces had been moved apart or rotated. | Require explicit graph closure plus coincident positions, opposing tangents, compatible elevation, equal widths, unique connector use, and valid path membership. |
| Construction | Only bounding rectangles were rendered for an open track; placement previews were fixed rectangles; straight overlap checks used zero-height centerline bounds. | Render individual module strips throughout construction, preview the actual snapped shape, detect overlapping drivable strips, and expose Close Circuit and module presets. |
| Distance queries | Nearest-track queries chose sample vertices; distance ignored elevation; interpolated samples retained wrong local coordinates. | Project onto line segments, preserve analytical module lengths, normalize spatial tangents, interpolate local coordinates, and use planar normals for widths. |
| Collision truth | Boundary points existed but there was no directly reusable collection of drivable polygons. | Expose sampled drivable strip polygons independently of Canvas and use them for grid/road checks. |
| Bézier geometry | Curvature measured angle change per parameter, not per meter. | Compute spatial curvature from curve derivatives and preserve open-path clamping. Add direct handle dragging. |
| Drag history | Escape discarded the history snapshot without restoring the document; drags snapped the module origin to the pointer. | Restore cancelled drafts, preserve grab offset, disconnect/reconnect moved modules, and commit one history entry on release. Autosave excludes active drafts. |
| Shortcuts and viewport | Typing R/F/Delete in inputs changed track geometry; wheel zoom used viewport center; Space drag was absent. | Ignore editor shortcuts in editable fields, anchor zoom at the cursor, support Space drag, release pointer capture, and handle cancel/blur. |
| Markers | New anchors always used localT = 0; broken anchors were ignored; markers could be added but not edited or removed. | Use projected local coordinates, reconcile anchors on valid geometry edits, warn on unresolved anchors, and expose distance/label/delete controls. |
| Grid | Rendering ignored slot overrides and startMarkerId; no off-track slot validation existed. | Share domain grid generation with rendering and validation; apply slot overrides and validate start/path references and positions. |
| Spectator frame | Rotation and margins were ignored; fit used a hardcoded padding; no race-frame preview existed. | Share rotated frame containment and asymmetric-margin fit; include grid positions; add margin/rotation editing, frame preview, and decorative overflow warnings. |
| Ghost | Wall-clock deltas drove simulation, making replay frame-dependent; pause/reset/step were missing. | Use integer fixed ticks, deterministic traversal events, start-marker-relative lap progress, pause/reset/step, and block runs on invalid circuits. |
| Pit and zones | Pit endpoint reconnection was not checked; pit markers were placed on the pit path; wrapped zones were rejected yet visually joined across the circuit. | Place pit markers on the primary path, validate endpoint reconnection and boxes, accept wrapping closed-path zones, draw seam-crossing zones in separate spans, and expose range editing. |
| Elevation and terrain | Terrain origin was off-center; terrain following changed only track starts; road following painted sparse samples; smooth/flatten ignored strength. | Center terrain, interpolate heights, update both module endpoints, paint cells under the road footprint, honor strength and an explicit flatten height, and show an elevation profile. |
| Themes and overrides | Kerb overrides appeared in the inspector but did not affect rendering. | Resolve authored properties before procedural rendering and apply per-module kerb/surface/width overrides without modifying them on theme changes. |
| Diagnostics | “Sections” counted sample points; sectors omitted part of the lap; issues could not be focused. | Count sections/runs, partition the whole lap, report elevation loss, expose a validation rule registry, and make issues focusable. |
| Startup | The BAT opened a browser after a fixed delay and could open the wrong port. | Let Vite open the browser after startup, require the selected port, and retain visible failure output. |
| Verification | Tests were mostly smoke checks and no CI/formatting setup existed. | Add behavioral regressions, fast domain tests in Node, formatting scripts, and a CI workflow for format, tests, build, and Chromium interactions. |

## Scope that remains partial or future work

These are not presented as completed simulator features:

- The ghost follows a selected authored route at a fixed diagnostic speed, reports marker/zone traversal, and stops on open-route endpoints. It does not simulate vehicle dynamics, enforce competitive DRS/joker/speed rules, or run races/championships.
- Racing Line supports points and handles. Pit Path was subsequently refactored to an open chain of track modules; old Bézier lanes are preserved until an explicit undoable rebuild. Automatic ideal-line generation, multiple alternate racing lines, advanced path insertion/reordering, and complete pit-box editing remain future work.
- Grid validation concerns category-neutral slot positions. Vehicle footprints, category-specific grid rules, and competitor assignment belong to the later simulation/category layers.
- Terrain remains a bounded numeric array in the document. Typed-array editing caches, advanced smoothing/transitions, banking, camber, and a dedicated interactive elevation-profile editor remain future work. Track Follows Terrain adjusts module endpoints with linear elevation between them.
- Themes and props are procedural prototypes. Rich prop assets, individually styled barriers/runoff by range, grip UI, and production environment generation are not complete.
- Editor selection is single-entity. Multi-selection and a unified layer/debug panel remain future work; centerline and spectator visibility controls already exist.
- Rendering memoizes geometry per document revision, but there is no separate geometry/theme cache-invalidation system yet.
- Explicit at-grade crossover modules have independent traversals and conflict warnings. Elevated crossings use configurable conservative clearance checks (default 5 m). Bézier and collision results use bounded sampling and are not an exact solid-modeling kernel.
- CI is supplied in the repository; hosted CI execution and cross-browser certification have not been performed here. Formatting and TypeScript checks exist; a dedicated ESLint ruleset is still a tooling follow-up.

## Verification

Run:

```sh
npm ci
npm run format:check
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

Regression coverage includes JSON preservation/rejection, save/reload/open, right curves and spatial length, connector alignment and closure, unfinished-track overlap, marker anchors, grid overrides, rotated margins, wrapped zones, pit reconnection, terrain coupling, immutable command snapshots, deterministic ghost events, constructing a circuit through the UI, drag undo/cancellation, keyboard input isolation, cursor-centered zoom, and Space panning.
