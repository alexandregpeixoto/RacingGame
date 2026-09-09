import { expect, test } from "@playwright/test";

test("opens the track creator vertical slice", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Track Creator", { exact: true })).toBeVisible();
  await expect(page.getByText("VALIDATION", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Test", exact: true }),
  ).toBeVisible();
});

test("edits an independent racing line and terrain without breaking the editor", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Racing Line/ }).click();
  const canvas = page.locator("canvas");
  const box = await canvas.boundingBox();
  if (!box) throw new Error("Canvas was not laid out");
  await page.mouse.click(box.x + 260, box.y + 260);
  await page.mouse.click(box.x + 660, box.y + 260);
  await page.mouse.click(box.x + 660, box.y + 520);
  await expect(page.locator(".bottom-panel")).toContainText("Paths 2");
  await page.getByRole("button", { name: /Pit Path/ }).click();
  await page.getByRole("button", { name: /Straight.*2 connectors/ }).click();
  await page.mouse.click(box.x + box.width / 2 - 20, box.y + box.height / 2);
  await expect(page.locator(".bottom-panel")).toContainText("Paths 3");
  await page.getByRole("button", { name: /Zones/ }).click();
  await page.mouse.click(box.x + 500, box.y + 300);
  await expect(page.locator(".bottom-panel")).toContainText("Zones 1");
  await page.getByRole("button", { name: /Props/ }).click();
  await page.mouse.click(box.x + box.width - 80, box.y + 180);
  await expect(page.locator(".bottom-panel")).toContainText("Props 1");
  await page.getByRole("button", { name: /Terrain/ }).click();
  await page.mouse.click(box.x + 500, box.y + 400);
  await expect(
    page.getByText("Terrain heightmap", { exact: true }),
  ).toBeVisible();
});
