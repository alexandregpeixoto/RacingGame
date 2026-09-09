import { useEffect, useMemo, useRef, useState } from "react";
import { CanvasViewport, type ViewportState } from "./editor/CanvasViewport";
import { buildAllPathGeometries, buildTrackGeometry, getModuleWorldBounds, getOpenConnectors, getWorldConnector, snapModuleToOpenConnector } from "./domain/track/geometry";
import { cloneDocument, createControlPoint, createEmptyDocument, createSampleDocument, createTerrain, ensureControlPath, hydrateDocument, id, touch } from "./domain/track/document";
import { getModuleDefinition, MODULE_DEFINITIONS } from "./domain/track/modules";
import { diagnostics, validateDocument } from "./domain/track/validation";
import { THEME_PACKS } from "./domain/track/themes";
import type { MarkerType, TrackDocument, TrackModule, TrackProp, Vec2 } from "./domain/track/types";
import { downloadDocument, loadDocument, parseDocument, saveDocument } from "./persistence";

type Tool = "select" | "place" | "markers" | "grid" | "spectator" | "test" | "racing-line" | "pit" | "zones" | "terrain" | "elevation" | "props";
type HistoryEntry = { before: TrackDocument; after: TrackDocument; label: string };

const TOOL_ITEMS: Array<{ id: Tool; label: string; icon: string }> = [
  { id: "select", label: "Select", icon: "⌁" }, { id: "place", label: "Construct", icon: "+" }, { id: "racing-line", label: "Racing Line", icon: "⌁" }, { id: "pit", label: "Pit Path", icon: "∿" }, { id: "markers", label: "Markers", icon: "⚑" }, { id: "zones", label: "Zones", icon: "▤" }, { id: "grid", label: "Grid", icon: "▦" }, { id: "terrain", label: "Terrain", icon: "▧" }, { id: "elevation", label: "Elevation", icon: "↕" }, { id: "props", label: "Props", icon: "✦" }, { id: "spectator", label: "Spectator", icon: "□" }, { id: "test", label: "Test", icon: "▶" },
];

export default function App() {
  const [document, setDocument] = useState<TrackDocument>(() => createSampleDocument());
  const [tool, setTool] = useState<Tool>("select");
  const [placingDefinitionId, setPlacingDefinitionId] = useState<TrackModule["definitionId"]>();
  const [placementPreview, setPlacementPreview] = useState<Vec2>();
  const [selectedModuleId, setSelectedModuleId] = useState<string>();
  const [selectedPathPointId, setSelectedPathPointId] = useState<string>();
  const [selectedPropId, setSelectedPropId] = useState<string>();
  const [viewport, setViewport] = useState<ViewportState>({ center: { x: 0, y: 30 }, zoom: 4.3 });
  const [showCenterline, setShowCenterline] = useState(true);
  const [spectatorVisible, setSpectatorVisible] = useState(true);
  const [report, setReport] = useState(() => validateDocument(document));
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [future, setFuture] = useState<HistoryEntry[]>([]);
  const [testRunning, setTestRunning] = useState(false);
  const [testDistance, setTestDistance] = useState(0);
  const [testElapsed, setTestElapsed] = useState(0);
  const [notice, setNotice] = useState("Ready");
  const [markerType, setMarkerType] = useState<MarkerType>("checkpoint");
  const [zoneType, setZoneType] = useState("drs");
  const [zonePathId, setZonePathId] = useState("primary");
  const [propType, setPropType] = useState<TrackProp["type"]>("tree");
  const [terrainBrush, setTerrainBrush] = useState(2);
  const [terrainStrength, setTerrainStrength] = useState(1);
  const [terrainMode, setTerrainMode] = useState<"raise" | "lower" | "smooth" | "flatten">("raise");
  const transientRef = useRef<TrackDocument | undefined>(undefined);
  const lastTestDistanceRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const geometry = useMemo(() => buildTrackGeometry(document), [document]);
  const allGeometries = useMemo(() => buildAllPathGeometries(document), [document]);
  const stats = useMemo(() => diagnostics(document), [document]);
  const selectedModule = document.modules.find((module) => module.id === selectedModuleId);
  const selectedPath = document.paths.find((path) => path.controlPoints?.some((point) => point.id === selectedPathPointId));
  const selectedPoint = selectedPath?.controlPoints?.find((point) => point.id === selectedPathPointId);
  const selectedProp = document.props.find((prop) => prop.id === selectedPropId);
  const placementStatus = useMemo<"ready" | "snap" | "invalid">(() => {
    if (!placingDefinitionId || !placementPreview) return "ready";
    const definition = getModuleDefinition(placingDefinitionId); if (!definition) return "invalid";
    const candidate: TrackModule = { id: "preview", definitionId: placingDefinitionId, transform: { position: { ...placementPreview, z: 0 }, rotation: 0 }, parameters: { ...definition.defaultParameters } };
    const snapped = snapModuleToOpenConnector(document, candidate, 18 / viewport.zoom);
    if (snapped.connection) return "snap";
    const candidateBounds = getModuleWorldBounds(candidate);
    const overlaps = document.modules.some((module) => { const bounds = getModuleWorldBounds(module); return candidateBounds.min.x < bounds.max.x && candidateBounds.max.x > bounds.min.x && candidateBounds.min.y < bounds.max.y && candidateBounds.max.y > bounds.min.y; });
    return overlaps ? "invalid" : "ready";
  }, [document, placingDefinitionId, placementPreview, viewport.zoom]);

  useEffect(() => {
    setReport(validateDocument(document));
    const timeout = window.setTimeout(() => { void saveDocument(document); }, 650);
    return () => window.clearTimeout(timeout);
  }, [document]);

  useEffect(() => {
    void loadDocument(document.id).then((saved) => {
      if (saved) setDocument(hydrateDocument(saved));
    }).catch(() => undefined);
    // The document id is intentionally stable for the initial local workspace.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!testRunning || !geometry) return;
    let last = performance.now(); let animation = 0;
    const tick = (now: number) => { const delta = Math.min(0.05, (now - last) / 1000); last = now; const previous = lastTestDistanceRef.current; const nextDistance = geometry.path.wrapDistance(previous + delta * 18); setTestElapsed((value) => value + delta); document.markers.filter((marker) => marker.type === "checkpoint" || marker.type === "sector" || marker.type === "timing-line" || marker.type === "speed-trap").forEach((marker) => { const markerDistance = geometry.path.wrapDistance(marker.location.distanceMeters); const crossed = previous <= nextDistance ? markerDistance >= previous && markerDistance < nextDistance : markerDistance >= previous || markerDistance < nextDistance; if (crossed) setNotice(`Ghost passed ${marker.type.replaceAll("-", " ")}`); }); lastTestDistanceRef.current = nextDistance; setTestDistance(nextDistance); animation = requestAnimationFrame(tick); };
    animation = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animation);
  }, [testRunning, geometry]);

  function commit(next: TrackDocument, label: string) {
    const before = cloneDocument(document); const after = touch(cloneDocument(next));
    setDocument(after); setHistory((items) => [...items, { before, after, label }]); setFuture([]); setNotice(label);
  }

  function selectTool(nextTool: Tool) {
    setTool(nextTool); setPlacingDefinitionId(undefined); setPlacementPreview(undefined); setSelectedPathPointId(undefined); setSelectedPropId(undefined);
    if (nextTool !== "test") setTestRunning(false);
  }

  function addModule(point: Vec2) {
    if (!placingDefinitionId) return;
    const definition = getModuleDefinition(placingDefinitionId); if (!definition) return;
    if (placementStatus === "invalid") { setNotice("Invalid placement: geometry overlaps an existing module"); return; }
    const module: TrackModule = { id: id("module"), definitionId: placingDefinitionId, transform: { position: { x: point.x, y: point.y, z: 0 }, rotation: 0 }, parameters: { ...definition.defaultParameters } };
    const snapped = snapModuleToOpenConnector(document, module, 18 / viewport.zoom); const next = cloneDocument(document);
    next.modules.push(snapped.module); next.paths[0].sourceModuleIds.push(snapped.module.id);
    if (snapped.connection) next.connections.push({ id: id("connection"), a: snapped.connection.a, b: snapped.connection.b });
    const endConnector = getWorldConnector(snapped.module, "end"); const openAfterPlacement = getOpenConnectors(next).filter((item) => item.module.id !== snapped.module.id);
    const secondTarget = endConnector ? openAfterPlacement.find((item) => Math.hypot(item.connector.position.x - endConnector.position.x, item.connector.position.y - endConnector.position.y) <= 18 / viewport.zoom && Math.abs(item.connector.width - endConnector.width) <= 2) : undefined;
    if (secondTarget) next.connections.push({ id: id("connection"), a: { moduleId: snapped.module.id, connectorId: "end" }, b: { moduleId: secondTarget.module.id, connectorId: secondTarget.connector.id } });
    commit(next, `Add ${definition.label}`); setSelectedModuleId(snapped.module.id); setPlacementPreview(undefined); selectTool("select");
  }

  function addMarkerAtPoint(point: Vec2) {
    const pathGeometry = allGeometries[markerType.includes("pit") ? "pit" : "primary"]; if (!pathGeometry) return;
    if (markerType === "start-finish" && document.markers.some((marker) => marker.type === "start-finish")) { setNotice("Only one Start/Finish marker is allowed"); return; }
    const projection = pathGeometry.path.nearestPoint(point); const next = cloneDocument(document);
    const marker = { id: id("marker"), type: markerType, location: { pathId: pathGeometry.path.samples[0]?.moduleId === "pit" ? "pit" : "primary", distanceMeters: projection.distanceMeters, anchor: projection.moduleId ? { moduleId: projection.moduleId, localT: 0 } : undefined }, configuration: { label: markerType.replaceAll("-", " ") } };
    next.markers.push(marker); if (markerType === "start-finish") next.grid.startMarkerId = marker.id; commit(next, `Add ${markerType.replaceAll("-", " ")}`); selectTool("select");
  }

  function addPathPoint(point: Vec2, pathId: string) {
    const next = cloneDocument(document); const path = ensureControlPath(next, pathId, pathId === "pit" ? "pit" : "racing-line", pathId === "pit" ? 6 : 1.4, pathId !== "pit");
    path.controlPoints?.push(createControlPoint(point)); commit(next, `Add ${pathId === "pit" ? "pit" : "Racing Line"} point`); setSelectedPathPointId(path.controlPoints?.at(-1)?.id); setSelectedModuleId(undefined);
  }

  function startTransient() { if (!transientRef.current) transientRef.current = cloneDocument(document); }
  function movePathPoint(pathId: string, pointId: string, point: Vec2) { startTransient(); const next = cloneDocument(document); const path = next.paths.find((item) => item.id === pathId); const controlPoint = path?.controlPoints?.find((item) => item.id === pointId); if (controlPoint) controlPoint.position = { ...controlPoint.position, x: point.x, y: point.y }; setDocument(next); }
  function moveModule(moduleId: string, point: Vec2) { startTransient(); const next = cloneDocument(document); const module = next.modules.find((item) => item.id === moduleId); if (module) module.transform.position = { ...module.transform.position, x: point.x, y: point.y }; setDocument(next); }
  function moveProp(propId: string, point: Vec2) { startTransient(); const next = cloneDocument(document); const prop = next.props.find((item) => item.id === propId); if (prop) prop.position = { ...prop.position, x: point.x, y: point.y }; setDocument(next); }

  function finishTransient() {
    if (!transientRef.current) return;
    const before = transientRef.current; const after = cloneDocument(document); transientRef.current = undefined;
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    setHistory((items) => [...items, { before, after, label: tool === "terrain" ? "Sculpt terrain" : tool === "racing-line" || tool === "pit" ? "Move path point" : tool === "props" ? "Move prop" : "Move module" }]); setFuture([]); setNotice("Edit committed");
  }

  function sculptTerrain(point: Vec2) {
    startTransient(); const next = cloneDocument(document); const terrain = next.terrain ?? createTerrain(); next.terrain = terrain;
    const cx = Math.floor((point.x - terrain.origin.x) / terrain.cellSizeMeters); const cy = Math.floor((point.y - terrain.origin.y) / terrain.cellSizeMeters); const sign = terrainMode === "raise" ? 1 : -1;
    const original = [...terrain.elevations];
    for (let y = Math.max(0, cy - terrainBrush); y <= Math.min(terrain.height - 1, cy + terrainBrush); y += 1) for (let x = Math.max(0, cx - terrainBrush); x <= Math.min(terrain.width - 1, cx + terrainBrush); x += 1) { const radius = Math.hypot(x - cx, y - cy); if (radius <= terrainBrush) { const falloff = 1 - radius / Math.max(1, terrainBrush); const index = y * terrain.width + x; if (terrainMode === "smooth") { const neighbors: number[] = []; for (let oy = -1; oy <= 1; oy += 1) for (let ox = -1; ox <= 1; ox += 1) { const nx = x + ox; const ny = y + oy; if (nx >= 0 && ny >= 0 && nx < terrain.width && ny < terrain.height) neighbors.push(original[ny * terrain.width + nx]); } terrain.elevations[index] = original[index] + (neighbors.reduce((sum, value) => sum + value, 0) / Math.max(1, neighbors.length) - original[index]) * falloff; } else if (terrainMode === "flatten") terrain.elevations[index] = original[index] * (1 - falloff); else terrain.elevations[index] += sign * terrainStrength * falloff; } }
    setDocument(next);
  }

  function addPitBox() {
    const pitGeometry = allGeometries.pit;
    if (!pitGeometry) { setNotice("Create a Pit Path before adding pit boxes"); return; }
    const next = cloneDocument(document); const order = next.pitBoxes.length + 1;
    next.pitBoxes.push({ id: id("pit-box"), pathId: "pit", distanceMeters: Math.min(pitGeometry.path.totalLengthMeters - 2, 4 + (order - 1) * 8), lateralOffsetMeters: 0, order, speedLimitKph: 60 });
    commit(next, "Add pit box");
  }

  function trackFollowsTerrain() {
    const next = cloneDocument(document); const terrain = next.terrain ?? createTerrain(); next.terrain = terrain;
    next.modules.forEach((module) => { const connector = getWorldConnector(module, "start"); if (!connector) return; module.transform.position.z = terrainHeightAt(terrain, connector.position); });
    commit(next, "Track follows terrain");
  }

  function terrainFollowsTrack() {
    if (!geometry) return;
    const next = cloneDocument(document); const terrain = next.terrain ?? createTerrain(); next.terrain = terrain;
    geometry.path.samples.filter((_, index) => index % 4 === 0).forEach((sample) => { const x = Math.floor((sample.position.x - terrain.origin.x) / terrain.cellSizeMeters); const y = Math.floor((sample.position.y - terrain.origin.y) / terrain.cellSizeMeters); if (x >= 0 && y >= 0 && x < terrain.width && y < terrain.height) terrain.elevations[y * terrain.width + x] = sample.position.z; });
    commit(next, "Terrain follows track");
  }

  function addZone(point: Vec2) {
    const pathGeometry = allGeometries[zonePathId]; if (!pathGeometry) { setNotice("Create the selected path before adding a zone"); return; } const projection = pathGeometry.path.nearestPoint(point); const next = cloneDocument(document); next.zones.push({ id: id("zone"), type: zoneType, pathId: zonePathId, startMeters: projection.distanceMeters, endMeters: projection.distanceMeters + 30, properties: { label: zoneType.toUpperCase() } }); commit(next, `Add ${zoneType} zone`); selectTool("select");
  }

  function addProp(point: Vec2) {
    const next = cloneDocument(document); const prop: TrackProp = { id: id("prop"), type: propType, position: { ...point, z: 0 }, rotation: 0, scale: 1, properties: {} }; next.props.push(prop); commit(next, `Add ${propType}`); setSelectedPropId(prop.id); setSelectedModuleId(undefined);
  }

  function setSpectatorCenter(point: Vec2) { const next = cloneDocument(document); next.spectatorFrame.center = point; commit(next, "Move spectator frame"); }

  function undo() { const entry = history.at(-1); if (!entry) return; setDocument(cloneDocument(entry.before)); setHistory((items) => items.slice(0, -1)); setFuture((items) => [...items, entry]); setNotice(`Undo: ${entry.label}`); }
  function redo() { const entry = future.at(-1); if (!entry) return; setDocument(cloneDocument(entry.after)); setFuture((items) => items.slice(0, -1)); setHistory((items) => [...items, entry]); setNotice(`Redo: ${entry.label}`); }

  function deleteSelected() {
    if (selectedModuleId) { const next = cloneDocument(document); next.modules = next.modules.filter((module) => module.id !== selectedModuleId); next.connections = next.connections.filter((connection) => connection.a.moduleId !== selectedModuleId && connection.b.moduleId !== selectedModuleId); next.paths[0].sourceModuleIds = next.paths[0].sourceModuleIds.filter((moduleId) => moduleId !== selectedModuleId); commit(next, "Delete module"); setSelectedModuleId(undefined); return; }
    if (selectedPath && selectedPathPointId) { const next = cloneDocument(document); const path = next.paths.find((item) => item.id === selectedPath.id); if (path?.controlPoints) path.controlPoints = path.controlPoints.filter((point) => point.id !== selectedPathPointId); commit(next, "Delete path point"); setSelectedPathPointId(undefined); return; }
    if (selectedPropId) { const next = cloneDocument(document); next.props = next.props.filter((prop) => prop.id !== selectedPropId); commit(next, "Delete prop"); setSelectedPropId(undefined); }
  }

  function rotateSelected() { if (!selectedModule) return; const next = cloneDocument(document); const module = next.modules.find((item) => item.id === selectedModule.id); if (module) module.transform.rotation += Math.PI / 2; commit(next, "Rotate module"); }
  function fitTrack() { if (!geometry) return; const width = Math.max(1, geometry.bounds.max.x - geometry.bounds.min.x); const height = Math.max(1, geometry.bounds.max.y - geometry.bounds.min.y); setViewport({ center: { x: (geometry.bounds.min.x + geometry.bounds.max.x) / 2, y: (geometry.bounds.min.y + geometry.bounds.max.y) / 2 }, zoom: Math.min(8, 500 / Math.max(width, height)) }); setNotice("Fit track to editor"); }
  function fitSpectatorFrame() { if (!geometry) return; const next = cloneDocument(document); const width = geometry.bounds.max.x - geometry.bounds.min.x; const height = geometry.bounds.max.y - geometry.bounds.min.y; next.spectatorFrame = { ...next.spectatorFrame, center: { x: (geometry.bounds.min.x + geometry.bounds.max.x) / 2, y: (geometry.bounds.min.y + geometry.bounds.max.y) / 2 }, size: { x: width + 24, y: height + 24 } }; commit(next, "Fit spectator frame"); }
  function changeTheme(themeId: string) { const theme = THEME_PACKS.find((item) => item.id === themeId); if (!theme) return; const next = cloneDocument(document); next.theme = { id: theme.id, name: theme.name }; commit(next, `Use ${theme.name}`); }
  function updateGrid(field: "slotCount" | "longitudinalSpacingMeters" | "lateralSpacingMeters", value: number) { const next = cloneDocument(document); next.grid[field] = Math.max(field === "slotCount" ? 1 : 0.5, value); commit(next, "Edit starting grid"); }
  function updateGridPattern(value: "none" | "alternating" | "custom") { const next = cloneDocument(document); next.grid.staggerPattern = value; commit(next, "Edit grid pattern"); }
  function updateSelectedModuleParameter(name: string, value: number) { if (!selectedModule) return; const next = cloneDocument(document); const module = next.modules.find((item) => item.id === selectedModule.id); if (module) { if (name === "__x") module.transform.position.x = value; else if (name === "__y") module.transform.position.y = value; else module.parameters[name] = value; } commit(next, `Edit ${name.replace("__", "position ")}`); }
  function updateSelectedModuleProperty(name: "surface" | "kerb", value: string) { if (!selectedModule) return; const next = cloneDocument(document); const module = next.modules.find((item) => item.id === selectedModule.id); if (module) { const properties = { ...module.properties }; if (value) properties[name] = value as never; else delete properties[name]; module.properties = Object.keys(properties).length > 0 ? properties : undefined; } commit(next, `Edit ${name} override`); }
  function updateSelectedPointHandle(handle: "inHandle" | "outHandle", axis: "x" | "y", value: number) { if (!selectedPathPointId || !selectedPath) return; const next = cloneDocument(document); const point = next.paths.find((path) => path.id === selectedPath.id)?.controlPoints?.find((item) => item.id === selectedPathPointId); if (point) point[handle][axis] = value; commit(next, "Edit Bézier handle"); }

  function newTrack() { if (!window.confirm("Create a new empty track? Unsaved changes are kept only in this browser.")) return; const next = createEmptyDocument(); setDocument(next); setHistory([]); setFuture([]); setSelectedModuleId(undefined); setNotice("New track"); }
  async function importFile(file: File) { try { const imported = parseDocument(await file.text()); setDocument(hydrateDocument(imported)); setHistory([]); setFuture([]); setSelectedModuleId(undefined); setNotice("Imported track"); } catch (error) { setNotice(error instanceof Error ? error.message : "Import failed"); } }

  useEffect(() => { const onKeyDown = (event: KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") { event.preventDefault(); event.shiftKey ? redo() : undo(); } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") { event.preventDefault(); redo(); } else if (event.key.toLowerCase() === "r") rotateSelected(); else if (event.key === "Delete") deleteSelected(); else if (event.key.toLowerCase() === "f") fitTrack(); else if (event.key === "Escape") { setPlacingDefinitionId(undefined); selectTool("select"); transientRef.current = undefined; } }; window.addEventListener("keydown", onKeyDown); return () => window.removeEventListener("keydown", onKeyDown); });

  return <div className="app-shell">
    <header className="topbar"><div className="brand"><span className="brand-mark">◒</span><div><strong>Track Creator</strong><small>spectator racing foundation</small></div></div><input className="track-name" value={document.metadata.name} onChange={(event) => setDocument((current) => ({ ...current, metadata: { ...current.metadata, name: event.target.value } }))} aria-label="Track name" /><div className="top-actions"><button onClick={newTrack}>New</button><button onClick={() => void saveDocument(document).then(() => setNotice("Saved locally"))}>Save</button><button onClick={undo} disabled={!history.length}>Undo</button><button onClick={redo} disabled={!future.length}>Redo</button><button className="accent" onClick={() => setReport(validateDocument(document))}>Validate</button><button className={testRunning ? "danger" : "accent"} onClick={() => { selectTool("test"); setTestRunning((running) => { if (!running) { setTestElapsed(0); setTestDistance(0); lastTestDistanceRef.current = 0; } return !running; }); }}>{testRunning ? "Stop Test" : "Test"}</button><button onClick={() => downloadDocument(document)}>Export</button><button onClick={() => fileInputRef.current?.click()}>Import</button><input ref={fileInputRef} type="file" accept="application/json,.json,.track.json" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void importFile(file); event.target.value = ""; }} /></div></header>
    <div className="workspace"><aside className="left-panel"><div className="panel-title">TOOLS</div>{TOOL_ITEMS.map((item) => <button key={item.id} className={`tool-button ${tool === item.id ? "active" : ""}`} onClick={() => selectTool(item.id)}><span>{item.icon}</span>{item.label}</button>)}<div className="panel-divider" /><div className="panel-title">MODULES</div>{MODULE_DEFINITIONS.map((definition) => <button key={definition.id} className={`module-button ${placingDefinitionId === definition.id ? "selected" : ""}`} onClick={() => { setTool("place"); setPlacingDefinitionId(definition.id); }}><span className="module-glyph">{definition.category === "straight" ? "━" : definition.id === "curve-left" ? "◜" : "◝"}</span><span><strong>{definition.label}</strong><small>{definition.category === "straight" ? "2 connectors" : "parameterized arc"}</small></span></button>)}<div className="tool-options">{tool === "markers" && <label>Marker type<select value={markerType} onChange={(event) => setMarkerType(event.target.value as MarkerType)}>{["checkpoint", "sector", "timing-line", "speed-trap", "start-finish", "pit-entry", "pit-exit"].map((value) => <option key={value}>{value}</option>)}</select></label>}{tool === "zones" && <><label>Zone type<select value={zoneType} onChange={(event) => setZoneType(event.target.value)}><option value="drs">DRS</option><option value="drs-detection">DRS detection</option><option value="yellow-flag">Yellow flag</option><option value="no-overtaking">No overtaking</option><option value="speed-limit">Speed limit</option><option value="pit-speed-limit">Pit speed limit</option></select></label><label>Path<select value={zonePathId} onChange={(event) => setZonePathId(event.target.value)}><option value="primary">Primary circuit</option><option value="pit">Pit path</option></select></label></>}{tool === "props" && <label>Prop type<select value={propType} onChange={(event) => setPropType(event.target.value as TrackProp["type"])}>{["tree", "light", "barrier", "grandstand", "marshal-post", "sign"].map((value) => <option key={value}>{value}</option>)}</select></label>}{tool === "pit" && <button className="wide-button" onClick={addPitBox}>Add pit box</button>}{tool === "terrain" && <><label>Brush mode<select value={terrainMode} onChange={(event) => setTerrainMode(event.target.value as "raise" | "lower" | "smooth" | "flatten")}><option value="raise">Raise</option><option value="lower">Lower</option><option value="smooth">Smooth</option><option value="flatten">Flatten</option></select></label><label>Brush size<input type="range" min="1" max="8" value={terrainBrush} onChange={(event) => setTerrainBrush(Number(event.target.value))} /></label><label>Strength<input type="range" min="0.1" max="4" step="0.1" value={terrainStrength} onChange={(event) => setTerrainStrength(Number(event.target.value))} /></label><button className="wide-button" onClick={trackFollowsTerrain}>Track follows terrain</button><button className="wide-button" onClick={terrainFollowsTrack}>Terrain follows track</button></>}</div><div className="panel-hint">Racing Line and Pit Path use Bézier control points. Terrain edits are reversible strokes.</div></aside>
      <main className="canvas-area"><CanvasViewport document={document} viewport={viewport} selectedModuleId={selectedModuleId} selectedPathPointId={selectedPathPointId} selectedPropId={selectedPropId} placingDefinitionId={placingDefinitionId} placementPreview={placementPreview} placementStatus={placementStatus} tool={tool} showCenterline={showCenterline} spectatorVisible={spectatorVisible} testDistance={testDistance} onViewportChange={setViewport} onSelectModule={(idValue) => { setSelectedModuleId(idValue); setSelectedPropId(undefined); setSelectedPathPointId(undefined); if (idValue) selectTool("select"); }} onSelectPathPoint={(pathId, idValue) => { void pathId; setSelectedPathPointId(idValue); setSelectedModuleId(undefined); setSelectedPropId(undefined); }} onSelectProp={(idValue) => { setSelectedPropId(idValue); setSelectedModuleId(undefined); setSelectedPathPointId(undefined); }} onPlaceModule={addModule} onAddMarker={addMarkerAtPoint} onAddPathPoint={addPathPoint} onMovePathPoint={movePathPoint} onAddZone={addZone} onAddProp={addProp} onSetSpectatorCenter={setSpectatorCenter} onTerrainStroke={sculptTerrain} onMoveModule={moveModule} onMoveProp={moveProp} onPlacementPreview={setPlacementPreview} onCommitMove={finishTransient} onCancelMove={() => { if (transientRef.current) setDocument(transientRef.current); transientRef.current = undefined; }} /><div className="canvas-toolbar"><button onClick={fitTrack}>Fit Editor</button><button onClick={fitSpectatorFrame}>Fit Frame</button><button className={showCenterline ? "active" : ""} onClick={() => setShowCenterline((value) => !value)}>Centerline</button><button className={spectatorVisible ? "active" : ""} onClick={() => setSpectatorVisible((value) => !value)}>Spectator Frame</button></div><div className="statusbar"><span>{notice}</span><span>{tool === "racing-line" ? "Bezier path editing" : tool === "pit" ? "Secondary pit path" : tool === "terrain" ? "Terrain heightmap" : "World coordinates · meters"}</span><span>{testRunning ? `Ghost ${testElapsed.toFixed(1)}s · ${testDistance.toFixed(1)}m` : `Zoom ${viewport.zoom.toFixed(1)}×`}</span></div></main>
      <aside className="right-panel"><div className="inspector-heading"><div><span className="eyebrow">INSPECTOR</span><h2>{selectedModule ? "Module" : selectedPoint ? "Path Point" : selectedProp ? "Prop" : "Circuit"}</h2></div><span className="status-dot" /></div>{selectedModule ? <ModuleInspector module={selectedModule} onRotate={rotateSelected} onDelete={deleteSelected} onParameter={updateSelectedModuleParameter} onProperty={updateSelectedModuleProperty} /> : selectedPoint && selectedPath ? <PathPointInspector point={selectedPoint} onHandle={updateSelectedPointHandle} onDelete={deleteSelected} /> : selectedProp ? <PropInspector prop={selectedProp} onChange={(field, value) => { const next = cloneDocument(document); const prop = next.props.find((item) => item.id === selectedProp.id); if (prop) (prop as unknown as Record<string, unknown>)[field] = value; commit(next, `Edit prop ${field}`); }} onDelete={deleteSelected} /> : <CircuitInspector document={document} stats={stats} onTheme={changeTheme} onGrid={updateGrid} onGridPattern={updateGridPattern} onEnvironment={(field, value) => { const next = cloneDocument(document); if (field === "runoff") next.environment.runoff = value as TrackDocument["environment"]["runoff"]; if (field === "barrier") next.environment.barrier = value as TrackDocument["environment"]["barrier"]; if (field === "kerb") next.environment.kerb = value as TrackDocument["environment"]["kerb"]; commit(next, `Edit ${field}`); }} onFitFrame={fitSpectatorFrame} />}{reportPanel(report)}</aside></div><footer className="bottom-panel"><div><span className="live-indicator" /> LOCAL-FIRST WORKSPACE</div><div>Paths {Object.keys(allGeometries).length} · Pit boxes {document.pitBoxes.length} · Props {document.props.length} · Zones {document.zones.length}</div><div>Undo {history.length} · {testRunning ? `ghost ${testDistance.toFixed(1)} m` : "Test mode ready"}</div></footer>
  </div>;
}

function ModuleInspector({ module, onRotate, onDelete, onParameter, onProperty }: { module: TrackModule; onRotate: () => void; onDelete: () => void; onParameter: (name: string, value: number) => void; onProperty: (name: "surface" | "kerb", value: string) => void }) {
  return <div className="inspector-content"><label>Module type<input value={getModuleDefinition(module.definitionId)?.label ?? module.definitionId} readOnly /></label><label>Position X<input type="number" value={module.transform.position.x.toFixed(2)} onChange={(event) => onParameter("__x", Number(event.target.value))} /></label><label>Position Y<input type="number" value={module.transform.position.y.toFixed(2)} onChange={(event) => onParameter("__y", Number(event.target.value))} /></label><label>Elevation delta<input type="number" step="0.1" value={module.parameters.elevationDelta ?? 0} onChange={(event) => onParameter("elevationDelta", Number(event.target.value))} /></label>{module.definitionId === "straight" ? <label>Length<input type="number" min="2" value={module.parameters.length} onChange={(event) => onParameter("length", Number(event.target.value))} /></label> : <label>Radius<input type="number" min="3" value={module.parameters.radius} onChange={(event) => onParameter("radius", Number(event.target.value))} /></label>}<label>Width<input type="number" min="2" value={module.parameters.width} onChange={(event) => onParameter("width", Number(event.target.value))} /></label><label>Surface override<select value={module.properties?.surface ?? "default"} onChange={(event) => onProperty("surface", event.target.value === "default" ? "" : event.target.value)}><option value="default">Theme default</option><option value="asphalt">Asphalt</option><option value="concrete">Concrete</option><option value="gravel">Gravel</option><option value="sand">Sand</option><option value="grass">Grass</option></select></label><label>Kerb override<select value={module.properties?.kerb ?? "default"} onChange={(event) => onProperty("kerb", event.target.value === "default" ? "" : event.target.value)}><option value="default">Theme default</option><option value="none">None</option><option value="red-white">Red / white</option><option value="blue-white">Blue / white</option></select></label><div className="inspector-actions"><button onClick={onRotate}>Rotate 90°</button><button className="danger-text" onClick={onDelete}>Delete</button></div></div>;
}

function PathPointInspector({ point, onHandle, onDelete }: { point: NonNullable<TrackDocument["paths"][number]["controlPoints"]>[number]; onHandle: (handle: "inHandle" | "outHandle", axis: "x" | "y", value: number) => void; onDelete: () => void }) {
  return <div className="inspector-content"><label>Point X<input type="number" value={point.position.x.toFixed(2)} readOnly /></label><label>Point Y<input type="number" value={point.position.y.toFixed(2)} readOnly /></label>{(["inHandle", "outHandle"] as const).map((handle) => <div className="handle-grid" key={handle}><span>{handle === "inHandle" ? "In handle" : "Out handle"}</span><input type="number" value={point[handle].x.toFixed(2)} onChange={(event) => onHandle(handle, "x", Number(event.target.value))} /><input type="number" value={point[handle].y.toFixed(2)} onChange={(event) => onHandle(handle, "y", Number(event.target.value))} /></div>)}<button className="wide-button danger-text" onClick={onDelete}>Delete point</button></div>;
}

function PropInspector({ prop, onChange, onDelete }: { prop: TrackProp; onChange: (field: string, value: string | number) => void; onDelete: () => void }) {
  return <div className="inspector-content"><label>Type<select value={prop.type} onChange={(event) => onChange("type", event.target.value)}>{["tree", "light", "barrier", "grandstand", "marshal-post", "sign"].map((value) => <option key={value}>{value}</option>)}</select></label><label>Scale<input type="number" min="0.1" step="0.1" value={prop.scale} onChange={(event) => onChange("scale", Number(event.target.value))} /></label><label>Rotation<input type="number" value={(prop.rotation * 180 / Math.PI).toFixed(1)} onChange={(event) => onChange("rotation", Number(event.target.value) * Math.PI / 180)} /></label><button className="wide-button danger-text" onClick={onDelete}>Delete prop</button></div>;
}

function CircuitInspector({ document, stats, onTheme, onGrid, onGridPattern, onEnvironment, onFitFrame }: { document: TrackDocument; stats: ReturnType<typeof diagnostics>; onTheme: (id: string) => void; onGrid: (field: "slotCount" | "longitudinalSpacingMeters" | "lateralSpacingMeters", value: number) => void; onGridPattern: (value: "none" | "alternating" | "custom") => void; onEnvironment: (field: "runoff" | "barrier" | "kerb", value: string) => void; onFitFrame: () => void }) {
  return <div className="inspector-content"><label>Track name<input value={document.metadata.name} readOnly /></label><label>Theme<select value={document.theme.id} onChange={(event) => onTheme(event.target.value)}>{THEME_PACKS.map((theme) => <option key={theme.id} value={theme.id}>{theme.name}</option>)}</select></label><div className="stat-grid"><div><small>LAP LENGTH</small><strong>{stats.lapLengthMeters.toFixed(1)} m</strong></div><div><small>MODULES</small><strong>{document.modules.length}</strong></div><div><small>MAX CURVATURE</small><strong>{stats.maxCurvature.toFixed(3)}</strong></div><div><small>MAX GRADE</small><strong>{(stats.maxGrade * 100).toFixed(1)}%</strong></div><div><small>ELEVATION GAIN</small><strong>{stats.elevationGainMeters.toFixed(1)} m</strong></div><div><small>GRID SLOTS</small><strong>{document.grid.slotCount}</strong></div></div><label>Grid slots<input type="number" min="1" value={document.grid.slotCount} onChange={(event) => onGrid("slotCount", Number(event.target.value))} /></label><label>Grid spacing<input type="number" min="0.5" value={document.grid.longitudinalSpacingMeters} onChange={(event) => onGrid("longitudinalSpacingMeters", Number(event.target.value))} /></label><label>Lateral spacing<input type="number" min="0.5" value={document.grid.lateralSpacingMeters} onChange={(event) => onGrid("lateralSpacingMeters", Number(event.target.value))} /></label><label>Stagger pattern<select value={document.grid.staggerPattern} onChange={(event) => onGridPattern(event.target.value as "none" | "alternating" | "custom")}><option value="none">None</option><option value="alternating">Alternating</option><option value="custom">Custom</option></select></label><label>Runoff<select value={document.environment.runoff} onChange={(event) => onEnvironment("runoff", event.target.value as TrackDocument["environment"]["runoff"])}><option>grass</option><option>gravel</option><option>sand</option><option>asphalt</option><option>concrete</option></select></label><label>Barrier<select value={document.environment.barrier} onChange={(event) => onEnvironment("barrier", event.target.value as TrackDocument["environment"]["barrier"])}><option>none</option><option>guardrail</option><option>wall</option><option>tire-stack</option><option>fence</option></select></label>{stats.sectorLengths.length > 0 && <div className="profile-list"><small>SECTOR LENGTHS</small>{stats.sectorLengths.map((sector) => <div key={sector.id}><span>{sector.id}</span><strong>{sector.lengthMeters.toFixed(1)} m</strong></div>)}</div>}{stats.pitLengthMeters > 0 && <div className="profile-list"><small>PIT PATH</small><div><span>Length</span><strong>{stats.pitLengthMeters.toFixed(1)} m</strong></div></div>}<button className="wide-button" onClick={onFitFrame}>Fit spectator frame to circuit</button></div>;
}

function reportPanel(report: ReturnType<typeof validateDocument>) {
  return <div className="diagnostics"><div className="diagnostics-title"><span>VALIDATION</span><strong className={report.valid ? "valid" : "invalid"}>{report.valid ? "VALID" : `${report.issues.filter((item) => item.severity === "error").length} ERRORS`}</strong></div>{report.issues.length === 0 ? <p className="empty-state">No issues detected. The circuit is ready for test mode.</p> : report.issues.slice(0, 10).map((item) => <div key={`${item.code}-${item.message}`} className={`issue ${item.severity}`}><span>{item.severity === "error" ? "!" : "i"}</span><div><strong>{item.message}</strong><small>{item.suggestedFix}</small></div></div>)}</div>;
}

function terrainHeightAt(terrain: NonNullable<TrackDocument["terrain"]>, point: Vec2): number {
  const x = Math.floor((point.x - terrain.origin.x) / terrain.cellSizeMeters);
  const y = Math.floor((point.y - terrain.origin.y) / terrain.cellSizeMeters);
  if (x < 0 || y < 0 || x >= terrain.width || y >= terrain.height) return 0;
  return terrain.elevations[y * terrain.width + x] ?? 0;
}
