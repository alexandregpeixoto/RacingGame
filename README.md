# Track Creator

Desktop-first 2D track authoring foundation for the spectator racing simulator.

## Run

```bash
npm install
npm run dev
```

On Windows, double-click `start-track-creator.bat` in the repository root. Node.js and npm must be installed (development is verified with Node 24).

The editor starts with a valid sample oval on first use and restores the last saved document on subsequent visits. Documents are autosaved to IndexedDB; Save writes explicitly, Open lists saved tracks, and Import/Export use versioned `.track.json` files. New and Import preserve the current document locally before switching.

## Implemented foundations

- Searchable 50-entry catalog: 37 road definitions and 13 contextual race-control/pit tools. Includes compound/progressive corners, width transitions, freeform roads, splits/merges, crossovers, and grade-separated crossings.
- Closed-loop centerline, width-aware boundaries, collision geometry, distance queries, and diagnostics.
- Independent Bézier Racing Line and modular open Pit Path construction using the same straights, curves, snapping, and inspector as the race track.
- Generic semantic markers, timing zones, DRS zones, pit boxes, and category-neutral starting grid.
- Selectable spectator aspect ratio (16:9 by default), world-space coverage, rotated margin-aware fitting, and letterboxed race preview independent of editor zoom.
- Elevation deltas, grade warnings, terrain heightmap sculpting, smoothing/flattening, and track/terrain following operations.
- Procedural Canvas2D rendering with realistic/cartoon themes and local module surface overrides.
- Basic props, pit-garage frontage, barriers, runoff, kerbs, selected-route fixed-step ghost diagnostics with marker/zone events, and grouped undo/redo.
- Runtime-validated, backward-compatible JSON import/export and IndexedDB persistence.

## Verification

```bash
npm run build
npm test
npm run format:check
npx playwright install chromium
npm run test:e2e
```

To run the same browser suite against the built app on Windows:

```powershell
npm run build
$env:TRACK_CREATOR_PRODUCTION = '1'
npm run test:e2e
Remove-Item Env:TRACK_CREATOR_PRODUCTION
```

Unit tests cover geometry, validation, terrain, schema compatibility, authoring, and deterministic ghost events. Browser tests cover construction, snapping, save/reload/open, import/export, invalid imports, drag history, frame/grid validation, and keyboard/viewport behavior.

See [the original scope audit](docs/development/SCOPE_AUDIT.md) for verified corrections and remaining roadmap work. This is a Track Creator foundation, not the complete race simulator.

## Editor controls

- Select a module preset, move over the canvas to preview placement, and click to place. Green indicates snapping; red indicates overlap.
- Close Circuit connects geometrically matching open ends. Invalid connections cannot produce a valid centerline.
- Drag a module to move it; Escape cancels the entire drag. Undo/Redo treats each drag as one change.
- R rotates, Delete removes selection, Ctrl/Cmd+D duplicates a module, F fits the editor, and Ctrl/Cmd+Z / Shift+Z undo/redo.
- Hold Space and drag to pan; scroll to zoom around the cursor.
- Markers and Zones have selectable lists with editing/deletion controls. Grid offers per-slot offsets.
- Preview Race Frame exposes aspect ratio and coverage width in the inspector. Closer/Wider resize the authored frame; changing ratios expands without cropping. Manual shrinking is allowed and diagnosed. Fit respects the ratio and margins.
- Test requires a valid circuit and offers run, pause, reset, and one fixed step. Timing events are independent of animation frame grouping.

## Building a pit lane

Choose **Pit Path**, then a straight or curve in **Pit Modules**. Pit pieces default to a 6 m width. The first piece snaps to the main centerline and creates a Pit Entry marker; subsequent pieces snap to pit connectors. Bring the last piece back to the main centerline to create Pit Exit, or use **Attach entry / exit** once both endpoints meet the track.

This legacy endpoint-attached pit workflow forms an open chain separate from the main circuit's connection graph; new explicit junction routes can share physical entry/exit pieces with the primary route. Pit modules support rotation, parameter editing, duplication, dragging, deletion, undo/redo, local saving, and JSON export. **Connect pit modules** joins matching free ends. **Pit lane width** updates the lane's modules together. Validation checks connectivity, junction position/elevation/direction, overlap away from junctions, and spectator-frame coverage.

Older Bézier pit paths still load unchanged. In Pit Path mode, **Rebuild with modules** clears their control points so you can construct a modular lane; Undo restores the previous layout. Existing pit boxes and markers are retained and may need repositioning for the rebuilt lane.

## Expanded catalog and explicit routes

Use the catalog search or its five categories. Geometry cards preview the generated shape. Placement offers parameter controls, a snap connector, and a traversal through junction pieces. The inspector supports additional parameters after placement. Compound corners support 2–12 ordered sections through `sectionCount`, radius fields, and per-section angle fields.

**Freeform Curve** is a structural road: click two or more canvas points, then **Finish Freeform**. Select it to drag points/handles or edit/add/remove controls in the inspector. It does not modify the Racing Line. **Loop Connector** takes two clicked, free, equal-width ports and creates an editable tangent-aligned connecting road. Overlapping placements are rejected.

**Active route → Route construction** creates secondary, shortcut, joker, service, or pit routes. Select a physical piece, choose its traversal and direction, and add it to the route in travel order. Reorder/remove route steps as needed. **Connect matching road ports** writes actual connector connections; route lists alone cannot close geometric gaps. Junctions attach at module endpoints, not arbitrary cuts into existing roads. Shortcut/Joker/Service/Pit Entry presets create a corresponding branch route, which you then extend and reconnect. A physical junction may be shared by the primary and alternate routes.

**Crossover** has independent crossing traversals and reports an at-grade conflict warning. Other overlapping roads require sufficient vertical clearance, configurable under **Crossing settings** (default 5 m). Overpass/Underpass have editable ramp length and rise/depth. Sampling is bounded and clearance checks are conservative, not an exact solid-modeling kernel.

The Test tool follows the active route. Closed routes repeat; open routes stop. DRS and speed zones produce diagnostic entry/exit events, not competitive eligibility, penalties, or vehicle dynamics. Service routes are excluded from spectator fit and generate nonblocking overflow warnings.

## Race-control and pit tools

Catalog timing/grid entries reuse the existing marker and grid inspectors. Place DRS Activation, then select its zone in **Linked zone** when placing DRS Detection. Speed Limit Start creates a zone; Speed Limit End moves its linked endpoint. Pit Speed Line offers an explicit start/end role and requires a pit route.

Pit Box Section and Pit Garage Section place grouped, path-anchored entities with count, spacing, and lateral offset. Edit or delete a group using **Pit sections** below the catalog. Garages are procedural frontage, not simulated buildings or drivable roads. The legacy endpoint-attached pit workflow remains supported alongside new explicit junction routes.

New exports use schema version 2. Version-1 imports preserve geometry/IDs, infer valid chain traversal order, and expand legacy frames to 16:9 without losing visible coverage. Invalid/incomplete circuits remain editable; malformed imports are rejected atomically. No generated mesh or sampling caches are serialized.
