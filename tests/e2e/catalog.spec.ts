import { expect, test, type Page } from "@playwright/test";
import type { TrackDocument } from "../../src/domain/track/types";
import { createEmptyDocument } from "../../src/domain/track/document";
import { MODULE_DEFINITIONS } from "../../src/domain/track/modules";
import { Buffer } from "node:buffer";

async function saved(page: Page): Promise<TrackDocument> {
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator(".statusbar")).toContainText("Saved locally");
  return page.evaluate(
    () =>
      new Promise<TrackDocument>((resolve, reject) => {
        const request = indexedDB.open("racing-game-track-creator", 1);
        request.onsuccess = () => {
          const db = request.result,
            read = db
              .transaction("tracks")
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

test("places and edits a variable-width module with undo, save and recovery", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await saved(page);
  await page.getByLabel("Search modules").fill("Widening");
  await page
    .getByRole("button", { name: "Widening Section Road geometry" })
    .click();
  const canvas = page.locator("canvas");
  await canvas.click({ position: { x: 80, y: 125 } });
  await expect(page.getByLabel("Module type")).toHaveValue("Widening Section");
  await page.getByLabel("endWidth", { exact: true }).fill("22");
  await page.getByLabel("endWidth", { exact: true }).press("Enter");
  const document = await saved(page),
    road = document.modules.at(-1)!;
  expect(road.definitionId).toBe("widening");
  expect(road.parameters.endWidth).toBe(22);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect((await saved(page)).modules.at(-1)!.parameters.endWidth).toBe(16);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await saved(page);
  await page.reload();
  expect((await saved(page)).modules.at(-1)!.parameters.endWidth).toBe(22);
  expect(errors).toEqual([]);
});

test("configures race aspect and coverage independently of the editor camera", async ({
  page,
}) => {
  await page.goto("/");
  const initial = await saved(page);
  await page
    .getByRole("button", { name: "Preview Race Frame", exact: true })
    .click();
  await expect(page.getByLabel("Aspect ratio", { exact: true })).toHaveValue(
    "16:9",
  );
  await page.getByLabel("Aspect ratio", { exact: true }).selectOption("4:3");
  await page.getByLabel("Coverage width (m)", { exact: true }).fill("90");
  await page.getByLabel("Coverage width (m)", { exact: true }).press("Enter");
  const cropped = await saved(page);
  expect(cropped.spectatorFrame.size).toEqual({ x: 90, y: 67.5 });
  expect(cropped.spectatorFrame.center).toEqual(initial.spectatorFrame.center);
  await expect(page.locator(".right-panel")).toContainText(
    "Track geometry extends outside the spectator camera frame",
  );
  await page
    .getByRole("button", { name: "Fit frame with margins", exact: true })
    .click();
  const fitted = await saved(page);
  expect(
    fitted.spectatorFrame.size.x / fitted.spectatorFrame.size.y,
  ).toBeCloseTo(4 / 3);
  await page.screenshot({ path: "test-results/race-frame-configured.png" });
  await page
    .getByRole("button", { name: "Preview Race Frame", exact: true })
    .click();
  expect((await saved(page)).modules).toEqual(initial.modules);
  await page.reload();
  expect((await saved(page)).spectatorFrame).toEqual(fitted.spectatorFrame);
});

test("authors a freeform structural road and edits its controls without touching Racing Line", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  const initial = await saved(page);
  await page.getByLabel("Search modules").fill("Freeform");
  await page
    .getByRole("button", { name: "Freeform Curve Road geometry" })
    .click();
  const canvas = page.locator("canvas");
  await canvas.click({ position: { x: 80, y: 130 } });
  await canvas.click({ position: { x: 160, y: 110 } });
  await canvas.click({ position: { x: 250, y: 140 } });
  await page
    .getByRole("button", { name: "Finish Freeform", exact: true })
    .click();
  await expect(page.getByLabel("Module type")).toHaveValue("Freeform Curve");
  const road = (await saved(page)).modules.at(-1)!;
  expect(road.controlPoints).toHaveLength(3);
  await page
    .getByRole("button", { name: "Add control point", exact: true })
    .click();
  expect((await saved(page)).modules.at(-1)!.controlPoints).toHaveLength(4);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  const result = await saved(page);
  expect(result.modules.at(-1)!.controlPoints).toHaveLength(3);
  expect(result.paths.filter((p) => p.kind === "racing-line")).toEqual(
    initial.paths.filter((p) => p.kind === "racing-line"),
  );
  expect(errors).toEqual([]);
});

test("creates a named alternate route and explicitly selects a junction traversal", async ({
  page,
}) => {
  await page.goto("/");
  await saved(page);
  await page.getByLabel("Search modules").fill("Track Split");
  await page.getByRole("button", { name: "Track Split Road geometry" }).click();
  await page.locator("canvas").click({ position: { x: 90, y: 150 } });
  await expect(page.getByLabel("Module type")).toHaveValue("Track Split");
  await page.getByText("Route construction", { exact: true }).click();
  await page.getByLabel("New route role").selectOption("shortcut");
  await page.getByRole("button", { name: "Create route", exact: true }).click();
  await page.getByLabel("Traversal", { exact: true }).selectOption("branch");
  await page
    .getByRole("button", { name: "Add selected traversal", exact: true })
    .click();
  const document = await saved(page),
    route = document.paths.at(-1)!;
  expect(route.metadata?.role).toBe("shortcut");
  expect(route.traversals).toHaveLength(1);
  expect(route.traversals![0].traversalId).toBe("branch");
  expect(document.paths[0].sourceModuleIds).toContain(
    route.traversals![0].moduleId,
  );
});

test("renders the complete road catalog in a production-compatible Canvas viewport", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const document = createEmptyDocument();
  document.metadata.name = "Module catalog gallery";
  document.modules = MODULE_DEFINITIONS.map((d, i) => ({
    id: `gallery-${i}`,
    definitionId: d.id,
    parameters: { ...d.defaultParameters },
    transform: {
      position: { x: (i % 5) * 300, y: -Math.floor(i / 5) * 260, z: 0 },
      rotation: 0,
    },
  }));
  document.paths[0].sourceModuleIds = document.modules.map((m) => m.id);
  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles({
    name: "gallery.track.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(document)),
  });
  await expect(page.getByRole("textbox", { name: "Track name" })).toHaveValue(
    "Module catalog gallery",
  );
  await page.getByRole("button", { name: "Fit Editor", exact: true }).click();
  await page.screenshot({ path: "test-results/module-catalog-gallery.png" });
  expect((await saved(page)).modules).toHaveLength(37);
  expect(errors).toEqual([]);
});

test("frame changes do not reset ghost progress", async ({ page }) => {
  await page.goto("/");
  await saved(page);
  await page.getByRole("button", { name: "Test", exact: true }).click();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page.getByRole("button", { name: "Reset ghost", exact: true }).click();
  await page.getByRole("button", { name: "Step ghost", exact: true }).click();
  await expect(page.locator(".left-panel")).toContainText("0.017 s");
  await page
    .getByRole("button", { name: "Preview Race Frame", exact: true })
    .click();
  await page.getByRole("button", { name: "Wider", exact: true }).click();
  await expect(page.locator(".left-panel")).toContainText("0.017 s");
});
