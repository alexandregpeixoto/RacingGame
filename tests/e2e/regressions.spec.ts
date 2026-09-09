import { expect, test, type Page } from "@playwright/test";
import { Buffer } from "node:buffer";
import { createSampleDocument } from "../../src/domain/track/document";
import type { TrackDocument } from "../../src/domain/track/types";

async function ready(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "Track name" })).toBeVisible();
}
async function saveAndRead(page: Page): Promise<TrackDocument> {
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator(".statusbar")).toContainText("Saved locally");
  return page.evaluate(async () => {
    const id = localStorage.getItem("track-creator.last-document")!;
    return new Promise<TrackDocument>((resolve, reject) => {
      const open = indexedDB.open("racing-game-track-creator", 1);
      open.onsuccess = () => {
        const db = open.result,
          read = db
            .transaction("tracks", "readonly")
            .objectStore("tracks")
            .get(id);
        read.onsuccess = () => {
          resolve(read.result);
          db.close();
        };
        read.onerror = () => reject(read.error);
      };
    });
  });
}
async function worldPoint(page: Page, x: number, y: number) {
  const box = await page.locator("canvas").boundingBox();
  if (!box) throw new Error("Missing canvas");
  return {
    x: box.x + box.width / 2 + x * 4.3,
    y: box.y + box.height / 2 - (y - 30) * 4.3,
  };
}

test("saves and recovers the same document and supports opening older local tracks", async ({
  page,
}) => {
  await ready(page);
  await page.getByRole("textbox", { name: "Track name" }).fill("Saved circuit");
  const original = await saveAndRead(page);
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Track name" })).toHaveValue(
    "Saved circuit",
  );
  await expect(
    page.getByRole("button", { name: "Undo", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "New", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Track name" })).toHaveValue(
    "Untitled Circuit",
  );
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await page
    .getByRole("button", { name: "Saved circuit", exact: true })
    .click();
  await expect(page.getByRole("textbox", { name: "Track name" })).toHaveValue(
    "Saved circuit",
  );
  expect((await saveAndRead(page)).id).toBe(original.id);
});

test("rejects malformed import atomically and round-trips authored extensions", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await ready(page);
  const original = await saveAndRead(page);
  const malformed = { ...original, modules: [null] };
  await page.locator('input[type="file"]').setInputFiles({
    name: "bad.track.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(malformed)),
  });
  await expect(page.locator(".statusbar")).toContainText(
    "Invalid or unsupported",
  );
  expect((await saveAndRead(page)).modules).toEqual(original.modules);
  const imported = createSampleDocument();
  imported.metadata.name = "Imported circuit";
  imported.overrides.push({
    id: "custom-kerb",
    targetId: "m-bottom",
    values: { kerb: "none", surface: "concrete" },
  });
  await page.locator('input[type="file"]').setInputFiles({
    name: "good.track.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(imported)),
  });
  await expect(page.getByRole("textbox", { name: "Track name" })).toHaveValue(
    "Imported circuit",
  );
  await expect(
    page.getByRole("button", { name: "Undo", exact: true }),
  ).toBeDisabled();
  expect(await saveAndRead(page)).toEqual(imported);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const stream = await (await downloadPromise).createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  expect(JSON.parse(Buffer.concat(chunks).toString())).toEqual(imported);
  expect(errors).toEqual([]);
});

test("drag commits once, preserves pointer offset, and Escape cancels without history", async ({
  page,
}) => {
  await ready(page);
  const start = await worldPoint(page, -15, 0);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 43, start.y - 43, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByLabel("Position X", { exact: true })).toHaveValue(
    "-30.00",
  );
  await expect(page.getByLabel("Position Y", { exact: true })).toHaveValue(
    "10.00",
  );
  await expect(page.locator(".bottom-panel")).toContainText("Undo 1");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.getByLabel("Position X", { exact: true })).toHaveValue(
    "-40.00",
  );
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect(page.getByLabel("Position X", { exact: true })).toHaveValue(
    "-30.00",
  );
  const moved = await worldPoint(page, -5, 10);
  await page.mouse.move(moved.x, moved.y);
  await page.mouse.down();
  await page.mouse.move(moved.x + 43, moved.y, { steps: 4 });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  const saved = await saveAndRead(page);
  expect(saved.modules[0].transform.position).toEqual({ x: -30, y: 10, z: 0 });
  await expect(page.locator(".bottom-panel")).toContainText("Undo 1");
});

test("typing shortcuts does not rotate, delete, or move the selected module", async ({
  page,
}) => {
  await ready(page);
  const point = await worldPoint(page, 0, 0);
  await page.mouse.click(point.x, point.y);
  const name = page.getByRole("textbox", { name: "Track name" });
  await name.fill("");
  await name.pressSequentially("rfr");
  await name.press("Delete");
  const saved = await saveAndRead(page);
  expect(saved.modules).toHaveLength(4);
  expect(saved.modules[0].transform.rotation).toBe(0);
});

test("builds a closed circuit from four snapped curves and validates a grid", async ({
  page,
}) => {
  await ready(page);
  await page.getByRole("button", { name: "New", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Track name" })).toHaveValue(
    "Untitled Circuit",
  );
  for (const [x, y] of [
    [0, 0],
    [30, 30],
    [0, 60],
    [-30, 30],
  ]) {
    await page.getByRole("button", { name: /Left Curve/ }).click();
    const point = await worldPoint(page, x, y);
    await page.mouse.move(point.x, point.y);
    await expect(page.locator(".statusbar")).toBeVisible();
    await page.mouse.click(point.x, point.y);
  }
  await page
    .getByRole("button", { name: "Close Circuit", exact: true })
    .click();
  await page.getByRole("button", { name: /Markers/ }).click();
  await page.getByLabel("Marker type").selectOption("start-finish");
  const point = await worldPoint(page, 0, 0);
  await page.mouse.click(point.x, point.y);
  await page.getByRole("button", { name: "Fit Frame", exact: true }).click();
  await expect(page.locator(".diagnostics-title")).toContainText("VALID");
  const saved = await saveAndRead(page);
  expect(saved.modules).toHaveLength(4);
  expect(saved.connections).toHaveLength(4);
  expect(saved.markers).toHaveLength(1);
  await page.getByRole("button", { name: "Test", exact: true }).click();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page.getByRole("button", { name: "Reset ghost", exact: true }).click();
  await page.getByRole("button", { name: "Step ghost", exact: true }).click();
  await expect(page.locator(".left-panel")).toContainText("0.017 s");
  await page.getByRole("button", { name: "Reset ghost", exact: true }).click();
  await page.getByRole("button", { name: "Step ghost", exact: true }).click();
  await expect(page.locator(".left-panel")).toContainText("0.017 s");
});

test("uses frame margins, previews framing and diagnoses an off-track grid", async ({
  page,
}) => {
  await ready(page);
  await page
    .locator(".left-panel")
    .getByRole("button", { name: /Spectator/ })
    .click();
  await page.getByLabel("left margin").fill("40");
  await page
    .getByRole("button", { name: "Fit frame with margins", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Preview Race Frame", exact: true })
    .click();
  await expect(page.locator("canvas")).toBeVisible();
  await page.screenshot({ path: "test-results/spectator-valid.png" });
  await page.getByLabel("Lateral spacing", { exact: true }).fill("60");
  await expect(page.locator(".diagnostics")).toContainText(
    "outside the drivable track",
  );
  await expect(
    page.getByRole("button", { name: "Test", exact: true }),
  ).toBeDisabled();
  await page.screenshot({ path: "test-results/spectator-audit.png" });
});
test("rejects an overlapping placement and keeps zoom anchored beneath the cursor", async ({
  page,
}) => {
  await ready(page);
  await page.getByRole("button", { name: /Straight.*2 connectors/ }).click();
  const point = await worldPoint(page, 0, 0);
  await page.mouse.move(point.x, point.y);
  await expect(page.locator("canvas")).toHaveAttribute(
    "aria-description",
    "Placement: invalid",
  );
  await page.mouse.click(point.x, point.y);
  await expect(page.locator(".statusbar")).toContainText("Invalid placement");
  await page.keyboard.press("Escape");
  await page.mouse.move(point.x, point.y);
  await page.mouse.wheel(0, -200);
  await expect(page.locator(".statusbar")).toContainText("Zoom 4.7");
  await page
    .locator(".left-panel")
    .getByRole("button", { name: /Markers/ })
    .click();
  await page.mouse.click(point.x, point.y);
  const saved = await saveAndRead(page);
  expect(saved.modules).toHaveLength(4);
  const checkpoint = saved.markers.find(
    (marker) => marker.type === "checkpoint",
  )!;
  expect(checkpoint.location.distanceMeters).toBeCloseTo(40, 1);
});

test("Space drag pans without modifying authored geometry", async ({
  page,
}) => {
  await ready(page);
  const original = await saveAndRead(page),
    point = await worldPoint(page, 0, 0);
  await page.mouse.move(point.x, point.y);
  await page.keyboard.down("Space");
  await page.mouse.down();
  await page.mouse.move(point.x + 80, point.y + 40, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up("Space");
  expect((await saveAndRead(page)).modules).toEqual(original.modules);
  await expect(page.locator(".bottom-panel")).toContainText("Undo 0");
});
