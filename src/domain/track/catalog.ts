import { MODULE_DEFINITIONS } from "./modules";
import { buildPathGeometry } from "./geometry";
import { id } from "./document";
import type { MarkerType, TrackDocument, Vec2 } from "./types";
import type { TrackProp } from "./types";

export const SEMANTIC_ENTRIES = [
  ["start-finish", "Start / Finish"],
  ["starting-grid", "Starting Grid"],
  ["sector", "Sector Line"],
  ["checkpoint", "Checkpoint"],
  ["speed-trap", "Speed Trap"],
  ["drs-detection", "DRS Detection"],
  ["drs-activation", "DRS Activation"],
  ["speed-limit-start", "Speed Limit Start"],
  ["speed-limit-end", "Speed Limit End"],
  ["pit-lane", "Pit Lane"],
  ["pit-box-section", "Pit Box Section"],
  ["pit-speed-line", "Pit Speed Line"],
  ["pit-garage-section", "Pit Garage Section"],
];
export const CATALOG = [
  ...MODULE_DEFINITIONS.map((d) => ({
    id: d.id,
    label: d.label,
    geometry: true,
    category:
      d.category === "transition"
        ? "Width & shape"
        : d.category === "topology"
          ? "Topology"
          : d.category === "pit"
            ? "Pit infrastructure"
            : "Basic geometry",
  })),
  ...SEMANTIC_ENTRIES.map(([id, label]) => ({
    id,
    label,
    geometry: false,
    category: id.startsWith("pit") ? "Pit infrastructure" : "Race control",
  })),
];

export interface CatalogSettings {
  lineRole?: "start" | "end";
  count: number;
  spacing: number;
  offset: number;
  speedKph: number;
  zoneId?: string;
}
export const DEFAULT_CATALOG_SETTINGS: CatalogSettings = {
  count: 8,
  spacing: 8,
  offset: 0,
  speedKph: 80,
};

/** Semantic palette actions edit the same authored markers/zones/grid as the inspectors. */
export function placeCatalogEntity(
  document: TrackDocument,
  action: string,
  pathId: string,
  point: Vec2,
  settings: CatalogSettings,
): TrackDocument {
  if (
    !Number.isInteger(settings.count) ||
    settings.count < 1 ||
    settings.count > 1000 ||
    !Number.isFinite(settings.spacing) ||
    settings.spacing <= 0 ||
    !Number.isFinite(settings.offset) ||
    !Number.isFinite(settings.speedKph) ||
    settings.speedKph <= 0
  )
    throw new Error("Invalid section count, spacing, offset or speed.");
  const next = structuredClone(document),
    path = buildPathGeometry(next, pathId)?.path;
  if (!path)
    throw new Error(
      "Complete the selected route before placing path-anchored entities.",
    );
  const projection = path.nearestPoint(point),
    s = projection.distanceMeters;
  const endingPitLine =
    action === "pit-speed-line" && settings.lineRole === "end";
  const location = {
    pathId,
    distanceMeters: s,
    anchor: projection.moduleId
      ? {
          moduleId: projection.moduleId,
          localT: projection.localT ?? 0,
          traversalId: projection.traversalId,
        }
      : undefined,
  };
  if (["start-finish", "sector", "checkpoint", "speed-trap"].includes(action)) {
    let marker =
      action === "start-finish"
        ? next.markers.find((m) => m.type === action)
        : undefined;
    if (marker) marker.location = location;
    else {
      marker = {
        id: id("marker"),
        type: action as MarkerType,
        location,
        configuration: { label: action },
      };
      next.markers.push(marker);
    }
    if (action === "start-finish") {
      next.grid.startMarkerId = marker.id;
      next.grid.pathId = pathId;
    }
  } else if (action === "starting-grid") {
    const start = next.markers.find(
      (m) => m.type === "start-finish" && m.location.pathId === pathId,
    );
    if (!start) throw new Error("Place Start / Finish on this route first.");
    next.grid = {
      ...next.grid,
      pathId,
      startMarkerId: start.id,
      slotCount: settings.count,
      longitudinalSpacingMeters: settings.spacing,
    };
  } else if (
    ["drs-activation", "speed-limit-start", "pit-speed-line"].includes(
      action,
    ) &&
    !endingPitLine
  ) {
    if (
      action === "pit-speed-line" &&
      next.paths.find((p) => p.id === pathId)?.kind !== "pit"
    )
      throw new Error("Choose a pit route first.");
    const zone = {
      id: id("zone"),
      pathId,
      type:
        action === "drs-activation"
          ? "drs"
          : action === "pit-speed-line"
            ? "pit-speed-limit"
            : "speed-limit",
      startMeters: s,
      endMeters: path.closed
        ? path.wrapDistance(s + 30)
        : Math.min(path.totalLengthMeters, s + 30),
      properties: { speedKph: settings.speedKph },
    };
    if (zone.endMeters === s)
      throw new Error("Place the start before the route endpoint.");
    next.zones.push(zone);
  } else if (
    action === "speed-limit-end" ||
    action === "drs-detection" ||
    endingPitLine
  ) {
    const zone = next.zones.find(
      (z) => z.id === settings.zoneId && z.pathId === pathId,
    );
    if (!zone)
      throw new Error("Select the zone to link in the palette options.");
    if (action === "speed-limit-end" || endingPitLine) {
      if (endingPitLine && zone.type !== "pit-speed-limit")
        throw new Error("Choose a pit speed-limit zone.");
      if (!zone.type.includes("speed-limit"))
        throw new Error("Choose a speed-limit zone.");
      if (s === zone.startMeters || (!path.closed && s < zone.startMeters))
        throw new Error("The zone end must follow its start.");
      zone.endMeters = s;
    } else {
      if (zone.type !== "drs") throw new Error("Choose a DRS activation zone.");
      next.markers.push({
        id: id("detection"),
        type: "timing-line",
        location,
        configuration: {
          label: "DRS Detection",
          role: "drs-detection",
          zoneId: zone.id,
        },
      });
    }
  } else if (action === "pit-box-section" || action === "pit-garage-section") {
    if (next.paths.find((p) => p.id === pathId)?.kind !== "pit")
      throw new Error("Choose a pit route first.");
    const group = id("pit-section");
    for (let i = 0; i < settings.count; i++) {
      const distanceMeters = s + i * settings.spacing;
      if (distanceMeters > path.totalLengthMeters)
        throw new Error("The complete section must fit along the pit lane.");
      if (action === "pit-box-section")
        next.pitBoxes.push({
          id: `${group}-${i}`,
          sectionId: group,
          pathId,
          distanceMeters,
          lateralOffsetMeters: settings.offset,
          order: Math.max(0, ...next.pitBoxes.map((box) => box.order)) + 1,
          speedLimitKph: settings.speedKph,
        });
      else {
        const sample = path.sampleAtDistance(distanceMeters),
          normalLength = Math.hypot(sample.tangent.x, sample.tangent.y),
          offset = settings.offset || sample.width / 2 + 6;
        next.props.push({
          id: `${group}-${i}`,
          type: "grandstand",
          position: {
            x: sample.position.x - (sample.tangent.y / normalLength) * offset,
            y: sample.position.y + (sample.tangent.x / normalLength) * offset,
            z: sample.position.z,
          },
          rotation: Math.atan2(sample.tangent.y, sample.tangent.x),
          scale: 1,
          properties: {
            facility: "pit-garage",
            group,
            pathId,
            distanceMeters,
            offset,
          },
        });
      }
    }
  }
  return next;
}

export function resolvedFacility(
  document: TrackDocument,
  prop: TrackProp,
): TrackProp {
  if (prop.properties.facility !== "pit-garage") return prop;
  const path = buildPathGeometry(
    document,
    String(prop.properties.pathId),
  )?.path;
  if (!path) return prop;
  const sample = path.sampleAtDistance(Number(prop.properties.distanceMeters)),
    offset = Number(prop.properties.offset),
    magnitude = Math.hypot(sample.tangent.x, sample.tangent.y) || 1;
  return {
    ...prop,
    position: {
      x: sample.position.x - (sample.tangent.y / magnitude) * offset,
      y: sample.position.y + (sample.tangent.x / magnitude) * offset,
      z: sample.position.z,
    },
    rotation: Math.atan2(sample.tangent.y, sample.tangent.x),
  };
}

export function pitSections(document: TrackDocument) {
  const groups = [
    ...new Set([
      ...document.pitBoxes.flatMap((b) => (b.sectionId ? [b.sectionId] : [])),
      ...document.props.flatMap((p) =>
        p.properties.facility === "pit-garage" &&
        typeof p.properties.group === "string"
          ? [String(p.properties.group)]
          : [],
      ),
    ]),
  ];
  return groups.map((group) => {
    const boxes = document.pitBoxes.filter((b) => b.sectionId === group),
      garages = document.props.filter((p) => p.properties.group === group),
      first = boxes[0];
    return {
      id: group,
      action: first ? "pit-box-section" : "pit-garage-section",
      pathId: first?.pathId ?? String(garages[0].properties.pathId),
      start:
        first?.distanceMeters ?? Number(garages[0].properties.distanceMeters),
      count: first ? boxes.length : garages.length,
      spacing: first
        ? (boxes[1]?.distanceMeters ?? first.distanceMeters + 8) -
          first.distanceMeters
        : garages[1]
          ? Number(garages[1].properties.distanceMeters) -
            Number(garages[0].properties.distanceMeters)
          : 8,
      offset:
        first?.lateralOffsetMeters ?? Number(garages[0].properties.offset),
      speedKph: first?.speedLimitKph ?? 80,
    };
  });
}
export function editPitSection(
  document: TrackDocument,
  group: string,
  values: Partial<CatalogSettings & { start: number }>,
  remove = false,
): TrackDocument {
  const section = pitSections(document).find((s) => s.id === group);
  if (!section) return document;
  const next = structuredClone(document);
  next.pitBoxes = next.pitBoxes.filter((b) => b.sectionId !== group);
  next.props = next.props.filter((p) => p.properties.group !== group);
  if (remove) return next;
  const settings = { ...section, ...values },
    path = buildPathGeometry(next, section.pathId)?.path;
  if (!path || settings.start < 0 || settings.start > path.totalLengthMeters)
    throw new Error("Section start must be within a valid pit route.");
  const result = placeCatalogEntity(
    next,
    section.action,
    section.pathId,
    path.positionAtDistance(settings.start),
    settings,
  );
  const added = pitSections(result).find(
    (s) => !pitSections(next).some((old) => old.id === s.id),
  )!;
  result.pitBoxes.forEach((b) => {
    if (b.sectionId === added.id) {
      b.id = b.id.replace(added.id, group);
      b.sectionId = group;
      b.order =
        document.pitBoxes.find((old) => old.id === b.id)?.order ?? b.order;
    }
  });
  result.props.forEach((p) => {
    if (p.properties.group === added.id) {
      p.id = p.id.replace(added.id, group);
      p.properties.group = group;
    }
  });
  return result;
}
