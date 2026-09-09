import { useEffect, useState } from "react";
import { CATALOG, pitSections, editPitSection } from "../domain/track/catalog";
import {
  createModuleGeometry,
  getModuleDefinition,
} from "../domain/track/modules";
import {
  connectMatchingConnectors,
  inferRouteTraversals,
} from "../domain/track/geometry";
import { changeFrameRatio, resizeFrame } from "../domain/track/authoring";
import type {
  TrackDocument,
  SpectatorFrame,
  TrackModule,
  RouteTraversal,
} from "../domain/track/types";

export function CommitNumber({
  label,
  value,
  onChange,
  min,
  step = 1,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  min?: number;
  step?: number;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  function commit() {
    const n = Number(text);
    if (text.trim() && Number.isFinite(n) && (min === undefined || n >= min)) {
      if (n !== value) onChange(n);
    } else setText(String(value));
  }
  return (
    <label>
      {label}
      <input
        aria-label={label}
        type="number"
        min={min}
        step={step}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            setText(String(value));
            e.stopPropagation();
          }
        }}
      />
    </label>
  );
}
export function ModulePalette({
  choose,
  selected,
  disabled = false,
}: {
  choose: (id: string) => void;
  selected?: string;
  disabled?: boolean;
}) {
  const [search, setSearch] = useState("");
  return (
    <section className="catalog" aria-label="Module catalog">
      <input
        aria-label="Search modules"
        placeholder="Search 50 entries…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      {[
        "Basic geometry",
        "Width & shape",
        "Topology",
        "Race control",
        "Pit infrastructure",
      ].map((category) => (
        <details
          key={category}
          open={search || category === "Basic geometry" ? true : undefined}
        >
          <summary>{category}</summary>
          {CATALOG.filter(
            (entry) =>
              entry.category === category &&
              entry.label.toLowerCase().includes(search.toLowerCase()),
          ).map((entry) => (
            <button
              className={`module-button ${selected === entry.id ? "selected" : ""}`}
              key={entry.id}
              disabled={disabled && entry.geometry}
              onClick={() => choose(entry.id)}
            >
              {entry.geometry && <ModuleThumbnail definitionId={entry.id} />}
              <span>
                <strong>{entry.label}</strong>
                <small>
                  {entry.id === "straight"
                    ? "2 connectors"
                    : ["curve-left", "curve-right"].includes(entry.id)
                      ? "parameterized arc"
                      : entry.geometry
                        ? "Road geometry"
                        : "Path-anchored tool"}
                </small>
              </span>
            </button>
          ))}
        </details>
      ))}
    </section>
  );
}

function ModuleThumbnail({ definitionId }: { definitionId: string }) {
  const geometry = createModuleGeometry(definitionId, {})!;
  const lines = geometry.traversals!.map((route) =>
    Array.from({ length: 41 }, (_, i) => route.curve.evaluate(i / 40)),
  );
  const points = lines.flat(),
    xs = points.map((p) => p.x),
    ys = points.map((p) => p.y),
    minX = Math.min(...xs),
    maxX = Math.max(...xs),
    minY = Math.min(...ys),
    maxY = Math.max(...ys);
  const scale = Math.min(
    30 / Math.max(1, maxX - minX),
    24 / Math.max(1, maxY - minY),
  );
  return (
    <svg width="36" height="32" viewBox="0 0 36 32" aria-hidden="true">
      {lines.map((line, i) => (
        <polyline
          key={i}
          points={line
            .map(
              (p) =>
                `${18 + (p.x - (minX + maxX) / 2) * scale},${16 - (p.y - (minY + maxY) / 2) * scale}`,
            )
            .join(" ")}
          fill="none"
          stroke="#ffd166"
          strokeWidth="2"
          strokeLinejoin="round"
        />
      ))}
    </svg>
  );
}
export function ParameterFields({
  module,
  change,
}: {
  module: TrackModule;
  change: (p: Record<string, number>) => void;
}) {
  const definition = getModuleDefinition(module.definitionId);
  const parameters = { ...definition?.defaultParameters, ...module.parameters };
  if (module.definitionId.startsWith("compound-")) {
    const count = Math.max(
      2,
      Math.min(12, Math.floor(parameters.sectionCount ?? 3)),
    );
    for (let i = 0; i < count; i++) {
      parameters[i === 0 ? "radius" : `radius${i + 1}`] ??= parameters.radius;
      parameters[`angle${i + 1}`] ??= parameters.angle / count;
    }
  }
  return (
    <>
      {Object.entries(parameters).map(([key, value]) => (
        <CommitNumber
          key={key}
          label={key.startsWith("angle") ? key + " (degrees)" : key}
          value={key.startsWith("angle") ? (value * 180) / Math.PI : value}
          step={0.1}
          onChange={(n) =>
            change({
              ...module.parameters,
              [key]: key.startsWith("angle") ? (n * Math.PI) / 180 : n,
            })
          }
        />
      ))}
    </>
  );
}
export function FrameControls({
  frame,
  change,
  fit,
}: {
  frame: SpectatorFrame;
  change: (frame: SpectatorFrame) => void;
  fit: () => void;
}) {
  const ratio = frame.aspectRatio ?? { x: 16, y: 9 },
    ratios = ["16:9", "16:10", "4:3", "1:1", "21:9", "9:16"];
  const [custom, setCustom] = useState(false),
    key = `${ratio.x}:${ratio.y}`;
  return (
    <section className="tool-options" aria-label="Race frame settings">
      <strong>Race frame coverage</strong>
      <label>
        Aspect ratio
        <select
          aria-label="Aspect ratio"
          value={custom || !ratios.includes(key) ? "custom" : key}
          onChange={(e) => {
            setCustom(e.target.value === "custom");
            if (e.target.value !== "custom") {
              const [x, y] = e.target.value.split(":").map(Number);
              change(changeFrameRatio(frame, { x, y }));
            }
          }}
        >
          {ratios.map((r) => (
            <option key={r}>{r}</option>
          ))}
          <option value="custom">Custom</option>
        </select>
      </label>
      {(custom || !ratios.includes(key)) && (
        <>
          <CommitNumber
            label="Ratio width"
            value={ratio.x}
            min={0.01}
            onChange={(x) => change(changeFrameRatio(frame, { x, y: ratio.y }))}
          />
          <CommitNumber
            label="Ratio height"
            value={ratio.y}
            min={0.01}
            onChange={(y) => change(changeFrameRatio(frame, { x: ratio.x, y }))}
          />
        </>
      )}
      <CommitNumber
        label="Coverage width (m)"
        value={frame.size.x}
        min={1}
        onChange={(width) => change(resizeFrame(frame, width))}
      />
      <p>Height: {frame.size.y.toFixed(2)} m</p>
      <button onClick={() => change(resizeFrame(frame, frame.size.x * 0.9))}>
        Closer
      </button>
      <button onClick={() => change(resizeFrame(frame, frame.size.x * 1.1))}>
        Wider
      </button>
      <button className="wide-button" onClick={fit}>
        Fit frame with margins
      </button>
      <p>
        Shrinking may crop roads. Validation reports overflow; the editor camera
        stays independent.
      </p>
    </section>
  );
}
export function RoutePanel({
  document,
  active,
  selectedModuleId,
  select,
  change,
}: {
  document: TrackDocument;
  active: string;
  selectedModuleId?: string;
  select: (id: string) => void;
  change: (d: TrackDocument, label: string) => void;
}) {
  const path = document.paths.find((p) => p.id === active),
    [role, setRole] = useState("secondary"),
    [choice, setChoice] = useState("main"),
    [reversed, setReversed] = useState(false);
  const module = document.modules.find((m) => m.id === selectedModuleId),
    traversals =
      module &&
      createModuleGeometry(
        module.definitionId,
        module.parameters,
        module.controlPoints,
      )?.traversals;
  useEffect(() => setChoice(traversals?.[0]?.id ?? "main"), [selectedModuleId]);
  const steps =
    path?.traversals ??
    (path ? inferRouteTraversals(document, path) : undefined);
  function update(list: RouteTraversal[]) {
    const next = structuredClone(document),
      target = next.paths.find((p) => p.id === active)!;
    target.traversals = list;
    target.sourceModuleIds = [...new Set(list.map((s) => s.moduleId))];
    change(next, "Edit route traversals");
  }
  return (
    <section className="tool-options" aria-label="Routes">
      <label>
        Active route
        <select
          aria-label="Active route"
          value={active}
          onChange={(e) => select(e.target.value)}
        >
          {document.paths
            .filter((p) => p.kind !== "racing-line")
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.id} · {p.metadata?.role ?? p.kind}
              </option>
            ))}
        </select>
      </label>
      <details>
        <summary>Route construction</summary>
        <label>
          New route role
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            {["secondary", "shortcut", "joker", "service", "pit"].map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </label>
        <button
          className="wide-button"
          onClick={() => {
            const next = structuredClone(document),
              id = `${role}-${crypto.randomUUID().slice(0, 6)}`;
            next.paths.push({
              id,
              kind: role === "pit" ? "pit" : "secondary",
              closed: false,
              widthMeters: role === "pit" ? 6 : 10,
              sourceModuleIds: [],
              traversals: [],
              metadata: { role },
            });
            change(next, "Create route");
            select(id);
          }}
        >
          Create route
        </button>
        {path && (
          <>
            <label>
              <input
                type="checkbox"
                checked={path.closed}
                disabled={path.kind === "primary-loop"}
                onChange={(e) => {
                  const next = structuredClone(document);
                  next.paths.find((p) => p.id === active)!.closed =
                    e.target.checked;
                  change(next, "Change route closure");
                }}
              />
              Closed route
            </label>
            <p>
              Select a road piece, then add its chosen traversal in travel
              order. Junction pieces may be shared by routes.
            </p>
            {module && (
              <>
                <label>
                  Traversal
                  <select
                    aria-label="Traversal"
                    value={choice}
                    onChange={(e) => setChoice(e.target.value)}
                  >
                    {traversals?.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.id}: {t.entry} → {t.exit}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={reversed}
                    onChange={(e) => setReversed(e.target.checked)}
                  />
                  Reverse direction
                </label>
                <button
                  className="wide-button"
                  onClick={() =>
                    update([
                      ...(steps ?? []),
                      { moduleId: module.id, traversalId: choice, reversed },
                    ])
                  }
                >
                  Add selected traversal
                </button>
              </>
            )}
            {(steps ?? []).map((s, i) => (
              <div key={i} className="route-step">
                <small>
                  {i + 1}. {s.moduleId} / {s.traversalId}
                  {s.reversed ? " ←" : " →"}
                </small>
                <button
                  aria-label={`Move route step ${i + 1} up`}
                  disabled={!i}
                  onClick={() => {
                    const list = [...steps!];
                    [list[i - 1], list[i]] = [list[i], list[i - 1]];
                    update(list);
                  }}
                >
                  ↑
                </button>
                <button
                  aria-label={`Remove route step ${i + 1}`}
                  onClick={() =>
                    update(steps!.filter((_, index) => index !== i))
                  }
                >
                  ×
                </button>
              </div>
            ))}
            {!steps && path.sourceModuleIds.length > 0 && (
              <button
                onClick={() =>
                  update(
                    path.sourceModuleIds.map((moduleId) => ({
                      moduleId,
                      traversalId: "main",
                      reversed: false,
                    })),
                  )
                }
              >
                Use placement order
              </button>
            )}
            <button
              className="wide-button"
              onClick={() =>
                change(
                  connectMatchingConnectors(document),
                  "Connect matching road ports",
                )
              }
            >
              Connect matching road ports
            </button>
          </>
        )}
      </details>
    </section>
  );
}

export function PitSectionPanel({
  document,
  change,
  error,
}: {
  document: TrackDocument;
  change: (d: TrackDocument, label: string) => void;
  error: (message: string) => void;
}) {
  return (
    <section className="tool-options" aria-label="Pit sections">
      {pitSections(document).map((section) => (
        <details key={section.id}>
          <summary>
            {section.action === "pit-box-section" ? "Pit boxes" : "Pit garages"}{" "}
            · {section.count}
          </summary>
          {(["count", "spacing", "offset", "start", "speedKph"] as const).map(
            (field) => (
              <CommitNumber
                key={field}
                label={`Section ${field}`}
                value={section[field]}
                min={field === "offset" ? undefined : field === "start" ? 0 : 1}
                onChange={(value) => {
                  try {
                    change(
                      editPitSection(document, section.id, {
                        [field]:
                          field === "count"
                            ? Math.min(100, Math.floor(value))
                            : value,
                      }),
                      "Edit pit section",
                    );
                  } catch (e) {
                    error(String(e));
                  }
                }}
              />
            ),
          )}
          <button
            onClick={() =>
              change(
                editPitSection(document, section.id, {}, true),
                "Delete pit section",
              )
            }
          >
            Delete section
          </button>
        </details>
      ))}
    </section>
  );
}
