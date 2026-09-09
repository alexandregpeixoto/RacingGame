import { expect, test, type Page } from "@playwright/test";
import { Buffer } from "node:buffer";
import {
  createControlPoint,
  createSampleDocument,
} from "../../src/domain/track/document";
import type { TrackDocument } from "../../src/domain/track/types";

async function savedDocument(page: Page): Promise<TrackDocument> {
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator(".statusbar")).toContainText("Saved locally");
  return page.evaluate(
    () =>
      new Promise<TrackDocument>((resolve, reject) => {
        const request = indexedDB.open("racing-game-track-creator", 1);
        request.onsuccess = () => {
          const db = request.result;
          const read = db
            .transaction("tracks", "readonly")
            .objectStore("tracks")
            .get(localStorage.getItem("track-creator.last-document")!);
          read.onsuccess = () => {
            resolve(read.result);
            db.close();
          };
          read.onerror = () => reject(read.error);
        };
      }),
  );
}

test("constructs a modular pit with junctions, boxes, undo and persistent module ownership", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "Track name" })).toBeVisible();
  const original = await savedDocument(page);
  await page.getByRole("button", { name: /Pit Path/ }).click();
  const canvas = page.locator("canvas"),
    bounds = await canvas.boundingBox();
  if (!bounds) throw Error("Missing canvas");
  const pieces: Array<[string, number, number]> = [
    ["Right Curve", -30, 0],
    ["Left Curve", -24, -6],
    ["Straight", -18, -12],
    ["Left Curve", 18, -12],
    ["Right Curve", 24, -6],
  ];
  for (const [name, x, y] of pieces) {
    await page
      .getByRole("button", { name: new RegExp(name + ".*(connectors|arc)") })
      .click();
    await page
      .getByLabel(
        name === "Straight" ? "Placement length" : "Placement radius",
        { exact: true },
      )
      .fill(name === "Straight" ? "36" : "6");
    const px = bounds.x + bounds.width / 2 + x * 4.3,
      py = bounds.y + bounds.height / 2 - (y - 30) * 4.3;
    await page.mouse.move(px, py);
    await expect(canvas).toHaveAttribute("aria-description", "Placement: snap");
    await page.mouse.click(px, py);
  }
  await expect(page.locator(".bottom-panel")).toContainText("Paths 2");
  await expect(page.locator(".diagnostics-title")).toContainText("VALID");
  await page.getByRole("button", { name: "Add pit box", exact: true }).click();
  await expect(page.locator(".bottom-panel")).toContainText("Pit boxes 1");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.locator(".bottom-panel")).toContainText("Pit boxes 0");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  const saved = await savedDocument(page);
  const pit = saved.paths.find((path) => path.kind === "pit")!;
  expect(pit.sourceModuleIds).toHaveLength(5);
  expect(pit.controlPoints).toBeUndefined();
  expect(saved.modules.slice(0, 4)).toEqual(original.modules);
  expect(saved.connections.slice(0, 4)).toEqual(original.connections);
  expect(
    saved.markers.find((marker) => marker.id === pit.entryMarkerId)?.type,
  ).toBe("pit-entry");
  expect(
    saved.markers.find((marker) => marker.id === pit.exitMarkerId)?.type,
  ).toBe("pit-exit");
  await page
    .getByRole("button", { name: "Select pit modules", exact: true })
    .click();
  await page.mouse.click(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2 + 42 * 4.3,
  );
  await expect(page.getByLabel("Length", { exact: true })).toHaveValue("36");
  await page.screenshot({ path: "test-results/modular-pit.png" });
  const middleX = bounds.x + bounds.width / 2,
    middleY = bounds.y + bounds.height / 2 + 42 * 4.3;
  await page.mouse.move(middleX, middleY);
  await page.mouse.down();
  await page.mouse.move(middleX, middleY + 34.4, { steps: 4 });
  await page.mouse.up();
  await expect(page.getByLabel("Position Y", { exact: true })).toHaveValue(
    "-20.00",
  );
  const moved = await savedDocument(page);
  expect(moved.modules.slice(0, 4)).toEqual(original.modules);
  expect(
    moved.paths.find((path) => path.kind === "pit")!.sourceModuleIds,
  ).toEqual(pit.sourceModuleIds);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.getByLabel("Position Y", { exact: true })).toHaveValue(
    "-12.00",
  );
  await savedDocument(page);
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Track name" })).toBeVisible();
  const restored = await savedDocument(page);
  expect(restored.paths).toEqual(saved.paths);
  expect(restored.modules).toEqual(saved.modules);
  expect(restored.pitBoxes).toEqual(saved.pitBoxes);
  expect(errors).toEqual([]);
});

test("loads legacy pit geometry and makes rebuilding with modules undoable", async ({
  page,
}) => {
  await page.goto("/");
  const document = createSampleDocument();
  document.paths.push({
    id: "legacy-lane",
    kind: "pit",
    closed: false,
    sourceModuleIds: [],
    widthMeters: 6,
    controlPoints: [
      createControlPoint({ x: -20, y: -20 }),
      createControlPoint({ x: 20, y: -20 }),
    ],
  });
  await page.locator('input[type="file"]').setInputFiles({
    name: "legacy.track.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(document)),
  });
  await expect(page.locator(".statusbar")).toContainText("Imported track");
  await page.getByRole("button", { name: /Pit Path/ }).click();
  await expect(
    page.getByRole("button", { name: /Straight.*2 connectors/ }),
  ).toBeDisabled();
  expect((await savedDocument(page)).paths[1].controlPoints).toEqual(
    document.paths[1].controlPoints,
  );
  await page
    .getByRole("button", { name: "Rebuild with modules", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: /Straight.*2 connectors/ }),
  ).toBeEnabled();
  expect((await savedDocument(page)).paths[1].controlPoints).toBeUndefined();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect((await savedDocument(page)).paths[1].controlPoints).toEqual(
    document.paths[1].controlPoints,
  );
});
