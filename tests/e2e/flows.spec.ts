// The main flows of the window, in a real browser, against the preview's stand-in bridge
// (src/renderer/mock.ts): what a person sees and clicks, not the components one by one.
import { expect, test, type Page } from "@playwright/test";

/** Opens the preview and waits until the composer is ready (the first load compiles the app). */
async function open(page: Page) {
  await page.goto("/mock.html");
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible({ timeout: 20_000 });
}

test("send a chat message and see the reply stream in", async ({ page }) => {
  await open(page);
  await page.getByRole("textbox", { name: "Message" }).fill("Hello there");
  await page.getByRole("button", { name: "Send" }).click();

  const main = page.getByRole("main");
  await expect(main.getByText("Hello there", { exact: true })).toBeVisible();
  // while the reply streams, Stop replaces Send; it goes once the answer is done
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await expect(main.getByRole("status")).toHaveText("Answer finished", { timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeHidden();
  await expect(main.getByText(/This is the preview build, so I am a mock/)).toBeVisible();
  await expect(main.getByText(/tok\/s/)).toBeVisible();

  // the chat is listed in the sidebar under its first message
  const sidebar = page.getByRole("complementary", { name: "Chat sidebar" });
  await expect(sidebar.getByRole("button", { name: "Hello there" })).toBeVisible();
});

test("open Settings, change the appearance, and find it kept", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await expect(settings.getByRole("heading", { name: "App settings" })).toBeVisible();

  await settings.getByRole("radio", { name: /^Dark/ }).check();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  await settings.getByRole("button", { name: "Close Settings" }).click();
  await expect(settings).toBeHidden();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Settings" }).getByRole("radio", { name: /^Dark/ })).toBeChecked();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("create a project, rename it, then delete it", async ({ page }) => {
  await open(page);
  const sidebar = page.getByRole("complementary", { name: "Chat sidebar" });
  await sidebar.getByRole("button", { name: "create a project" }).click();
  await page.getByRole("button", { name: "＋ New project" }).click();

  const name = page.getByRole("textbox", { name: "Project name" });
  await name.fill("Heron survey");
  await name.press("Tab");
  await expect(sidebar.getByRole("button", { name: /^Heron survey/ })).toBeVisible();

  // the delete asks first; saying no keeps the project
  let asked = "";
  page.once("dialog", (d) => { asked = d.message(); void d.dismiss(); });
  await page.getByRole("button", { name: "Delete project" }).click();
  await expect.poll(() => asked).toContain('Delete the project "Heron survey"?');
  await expect(sidebar.getByRole("button", { name: /^Heron survey/ })).toBeVisible();

  page.once("dialog", (d) => void d.accept());
  await page.getByRole("button", { name: "Delete project" }).click();
  await expect(sidebar.getByRole("button", { name: /^Heron survey/ })).toBeHidden();
  await expect(sidebar.getByRole("button", { name: /^Projects 0/ })).toBeVisible();
});
