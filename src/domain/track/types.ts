export type ModuleDefinitionId = string;

export interface Vec2 {
  x: number;
  y: number;
}

export interface Vec3 extends Vec2 {
  z: number;
}

export interface Transform3D {
  position: Vec3;
  rotation: number;
}

export interface TrackMetadata {
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorldSettings {
  units: "meters";
  upAxis: "z";
}

export interface ConnectorDefinition {
  id: string;
  position: Vec3;
  tangent: number;
  width: number;
  leftWidth?: number;
  rightWidth?: number;
  type: "track";
}

export interface ConnectorReference {
  moduleId: string;
  connectorId: ConnectorDefinition["id"];
}

export interface TrackModule {
  id: string;
  definitionId: ModuleDefinitionId;
  transform: Transform3D;
  parameters: Record<string, number>;
  controlPoints?: PathControlPoint[];
  properties?: TrackPropertyOverride;
}

export interface ModuleConnection {
  id: string;
  a: ConnectorReference;
  b: ConnectorReference;
}

export interface TrackPath {
  id: string;
  kind: "primary-loop" | "secondary" | "racing-line" | "pit";
  closed: boolean;
  sourceModuleIds: string[];
  traversals?: RouteTraversal[];
  entryMarkerId?: string;
  exitMarkerId?: string;
  widthMeters?: number;
  controlPoints?: PathControlPoint[];
  metadata?: Record<string, string | number | boolean>;
}

export interface RouteTraversal {
  moduleId: string;
  traversalId: string;
  reversed: boolean;
}

export interface PathControlPoint {
  id: string;
  position: Vec3;
  inHandle: Vec2;
  outHandle: Vec2;
}

export interface TrackLocation {
  pathId: string;
  distanceMeters: number;
  anchor?: { moduleId: string; localT: number; traversalId?: string };
}

export type MarkerType =
  | "start-finish"
  | "pit-entry"
  | "pit-exit"
  | "sector"
  | "checkpoint"
  | "timing-line"
  | "speed-trap";

export interface TrackMarker {
  id: string;
  type: MarkerType;
  location: TrackLocation;
  configuration: Record<string, string | number | boolean>;
}

export interface GridSlotOverride {
  slot: number;
  distanceOffsetMeters?: number;
  lateralOffsetMeters?: number;
}

export interface StartingGridDefinition {
  pathId: string;
  startMarkerId: string;
  slotCount: number;
  longitudinalSpacingMeters: number;
  lateralSpacingMeters: number;
  staggerPattern: "none" | "alternating" | "custom";
  slots: GridSlotOverride[];
}

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface SpectatorFrame {
  aspectRatio?: Vec2;
  center: Vec2;
  size: Vec2;
  rotation: number;
  margins: Insets;
  required: boolean;
}

export interface TrackPropertyOverride {
  surface?: "asphalt" | "concrete" | "gravel" | "sand" | "grass";
  grip?: number;
  widthMeters?: number;
  kerb?: "none" | "red-white" | "blue-white";
}

export interface ThemeReference {
  id: string;
  name: string;
}

export interface TrackOverride {
  id: string;
  targetId: string;
  values: TrackPropertyOverride;
}

export interface TerrainHeightmap {
  width: number;
  height: number;
  cellSizeMeters: number;
  origin: Vec2;
  elevations: number[];
}

export interface TrackProp {
  id: string;
  type: "tree" | "light" | "barrier" | "grandstand" | "marshal-post" | "sign";
  position: Vec3;
  rotation: number;
  scale: number;
  properties: Record<string, string | number | boolean>;
}

export interface EnvironmentSettings {
  runoff: "grass" | "gravel" | "sand" | "asphalt" | "concrete";
  barrier: "none" | "guardrail" | "wall" | "tire-stack" | "fence";
  kerb: "none" | "red-white" | "blue-white" | "yellow-black";
}

export interface TrackZone {
  id: string;
  type: string;
  pathId: string;
  startMeters: number;
  endMeters: number;
  properties: Record<string, string | number | boolean>;
}

export interface PitBox {
  sectionId?: string;
  id: string;
  pathId: string;
  distanceMeters: number;
  lateralOffsetMeters: number;
  order: number;
  speedLimitKph: number;
}

export interface TrackDocument {
  minimumClearanceMeters?: number;
  schemaVersion: number;
  id: string;
  metadata: TrackMetadata;
  world: WorldSettings;
  modules: TrackModule[];
  connections: ModuleConnection[];
  paths: TrackPath[];
  markers: TrackMarker[];
  zones: TrackZone[];
  grid: StartingGridDefinition;
  spectatorFrame: SpectatorFrame;
  theme: ThemeReference;
  overrides: TrackOverride[];
  terrain?: TerrainHeightmap;
  props: TrackProp[];
  environment: EnvironmentSettings;
  pitBoxes: PitBox[];
}

export interface ParametricCurve {
  evaluate(t: number): Vec3;
  tangent(t: number): Vec3;
  curvature(t: number): number;
  length(): number;
}

export interface PathSample {
  s: number;
  position: Vec3;
  tangent: Vec3;
  curvature: number;
  width: number;
  leftWidth?: number;
  rightWidth?: number;
  traversalId?: string;
  moduleId: string;
  localT: number;
}

export interface TrackProjection {
  traversalId?: string;
  distanceMeters: number;
  position: Vec3;
  distanceToTrack: number;
  moduleId?: string;
  localT?: number;
}

export interface SampledPath {
  closed: boolean;
  drivablePolygons: Vec3[][];
  totalLengthMeters: number;
  samples: PathSample[];
  leftBoundary: Vec3[];
  rightBoundary: Vec3[];
  positionAtDistance(distance: number): Vec3;
  tangentAtDistance(distance: number): Vec3;
  sampleAtDistance(distance: number): PathSample;
  nearestPoint(position: Vec2): TrackProjection;
  wrapDistance(distance: number): number;
}

export interface TrackGeometry {
  path: SampledPath;
  bounds: { min: Vec2; max: Vec2 };
}

export interface ValidationIssue {
  code: string;
  severity: "error" | "warning" | "info";
  message: string;
  entityIds: string[];
  location?: Vec2;
  suggestedFix?: string;
}

export interface ValidationReport {
  valid: boolean;
  issues: ValidationIssue[];
  generatedAt: number;
}

export interface ModuleGeometry {
  curve: ParametricCurve;
  width: number;
  connectors: ConnectorDefinition[];
  traversals?: ModuleTraversal[];
}

export interface ModuleTraversal {
  id: string;
  entry: string;
  exit: string;
  curve: ParametricCurve;
  widthAt(t: number): { left: number; right: number };
}

export interface ModuleDefinition {
  id: ModuleDefinitionId;
  label: string;
  category: "straight" | "curve" | "transition" | "topology" | "pit";
  defaultParameters: Record<string, number>;
  createGeometry(
    parameters: Record<string, number>,
    controlPoints?: PathControlPoint[],
  ): ModuleGeometry;
}
