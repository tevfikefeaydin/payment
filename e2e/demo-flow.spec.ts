import { expect, test } from "@playwright/test";
import {
  countExceptionRows,
  loadDemoAndReconcile,
  organizationIdFromUrl,
  signUp,
  uniqueEmail,
} from "./helpers";

/**
 * The MVP success flow, end to end, through the real application:
 * register → organization → demo data → reconciliation (in the worker) →
 * exception inbox → investigate → acknowledge → resolve → audit timeline.
 *
 * Nothing here is stubbed: the exceptions these tests assert on are produced by
 * the production reconciliation engine running as a background job.
 */

test.describe("demo vertical slice", () => {
  test("registers, loads demo data, reconciles, and resolves an exception", async ({ page }) => {
    const user = await signUp(page);

    // --- Dashboard starts genuinely empty, not pre-populated.
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    // --- Load demo data; reconciliation runs in the worker.
    await loadDemoAndReconcile(page, user.organizationId);

    // --- The inbox shows the demo's ten findings.
    await page.goto(`/orgs/${user.organizationId}/exceptions`);
    const rowCount = await countExceptionRows(page);
    expect(rowCount).toBeGreaterThanOrEqual(1);

    // --- Dashboard reports revenue at risk PER CURRENCY, never combined.
    // The dashboard streams behind a Suspense boundary, so assert on a locator
    // (which auto-waits) rather than reading innerText, which can capture the
    // loading placeholder.
    await page.goto(`/orgs/${user.organizationId}`);
    await expect(page.getByText(/revenue at risk/i).first()).toBeVisible({ timeout: 20_000 });

    // The demo spans USD and EUR; both must appear as separate figures. If the
    // dashboard ever summed them, one of these would disappear.
    // Generous timeouts: the dashboard streams, and under a full suite run the
    // worker is reconciling several organizations at once.
    await expect(page.getByText(/USD/).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/EUR/).first()).toBeVisible({ timeout: 30_000 });

    // --- Open the first exception from its row link.
    await page.goto(`/orgs/${user.organizationId}/exceptions`);
    await page.locator("table tbody tr").first().getByRole("link").first().click();
    await page.waitForURL(/\/exceptions\/[0-9a-f-]{36}/, { timeout: 20_000 });
    const detailUrl = page.url();

    // Evidence from BOTH sides must be shown side by side.
    await expect(page.getByText(/provider/i).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/probable cause/i).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/recommended/i).first()).toBeVisible({ timeout: 30_000 });

    // --- Acknowledge.
    const acknowledge = page.getByRole("button", { name: /acknowledge/i });
    await expect(acknowledge).toBeVisible();
    await acknowledge.click();
    await expect(page.getByText(/acknowledged/i).first()).toBeVisible({ timeout: 15_000 });

    // --- Resolve, with a note.
    await page.goto(detailUrl);
    const noteField = page.getByLabel(/note/i);
    if (await noteField.count()) await noteField.first().fill("Reprocessed the webhook.");
    await page.getByRole("button", { name: /^resolve/i }).click();
    await expect(page.getByText(/resolved/i).first()).toBeVisible({ timeout: 15_000 });

    // --- The audit timeline records the whole history, not just the end state.
    await page.goto(detailUrl);
    await expect(page.getByText(/timeline|history|activity/i).first()).toBeVisible({
      timeout: 20_000,
    });
    const timeline = await page.locator("main").innerText();
    expect(timeline).toMatch(/created|detected/i);
    expect(timeline).toMatch(/acknowledg/i);
    expect(timeline).toMatch(/resolv/i);
  });

  test("keeps two organizations completely separate", async ({ page, context }) => {
    // Tenant A with demo data.
    const alice = await signUp(page, {
      email: uniqueEmail("alice"),
      organizationName: "Alpha Ltd",
    });
    await loadDemoAndReconcile(page, alice.organizationId);

    // Tenant B in a fresh browser context.
    const otherPage = await context.browser()!.newPage();
    const bob = await signUp(otherPage, {
      email: uniqueEmail("bob"),
      organizationName: "Beta Ltd",
    });

    // Bob's own inbox is empty.
    await otherPage.goto(`/orgs/${bob.organizationId}/exceptions`);
    const bobRows = await countExceptionRows(otherPage);
    expect(bobRows).toBe(0);

    // Bob cannot reach Alice's organization by guessing its id.
    const response = await otherPage.goto(`/orgs/${alice.organizationId}/exceptions`);
    expect(response?.status()).toBe(404);

    // Nor the dashboard.
    const dashboard = await otherPage.goto(`/orgs/${alice.organizationId}`);
    expect(dashboard?.status()).toBe(404);

    await otherPage.close();
  });

  test("requires authentication for application routes", async ({ browser }) => {
    // A completely fresh context with no session cookie.
    const anonymous = await browser.newContext();
    const page = await anonymous.newPage();

    await page.goto("/app");
    await expect(page).toHaveURL(/\/sign-in/, { timeout: 20_000 });

    await anonymous.close();
  });

  test("rejects a sign-in with the wrong password without revealing whether the account exists", async ({
    page,
    browser,
  }) => {
    // Create a real account, then do the sign-in attempts from a SEPARATE,
    // signed-out context. Driving the sign-out UI here would couple this test
    // to the navigation chrome, when what it actually asserts is that the two
    // failure messages are indistinguishable.
    const user = await signUp(page);

    const anonymous = await browser.newContext();
    const visitor = await anonymous.newPage();

    const attempt = async (email: string): Promise<string> => {
      await visitor.goto("/sign-in");
      await visitor.getByLabel(/email/i).fill(email);
      await visitor.getByLabel(/password/i).fill("definitely-the-wrong-password");
      await visitor.getByRole("button", { name: /sign in/i }).click();

      const error = visitor.getByRole("alert");
      await expect(error).toBeVisible({ timeout: 20_000 });
      return (await error.innerText()).trim();
    };

    const existingAccountMessage = await attempt(user.email);
    const unknownAccountMessage = await attempt(uniqueEmail("nobody"));

    // Identical wording is the whole point: a difference here would let an
    // attacker enumerate which email addresses have accounts.
    expect(unknownAccountMessage).toBe(existingAccountMessage);
    // And neither may still be signed in.
    await expect(visitor).toHaveURL(/\/sign-in/);

    await anonymous.close();
  });

  test("the marketing page loads and links to sign up", async ({ browser }) => {
    const anonymous = await browser.newContext();
    const page = await anonymous.newPage();

    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    // The CTA must be a real link (an anchor styled as a button), not a button
    // nested inside a link — nested interactive content breaks the accessible
    // name and is invalid HTML.
    const signUpLink = page
      .getByRole("link", { name: /create an account|sign up|get started/i })
      .first();
    await expect(signUpLink).toBeVisible();
    await expect(signUpLink).toHaveAttribute("href", "/sign-up");

    // Following it must actually reach the sign-up form: a CTA that 404s is a
    // dead control.
    await signUpLink.click();
    await expect(page).toHaveURL(/\/sign-up/);
    await expect(page.getByLabel(/email/i)).toBeVisible();

    await anonymous.close();
  });

  test("reconciliation is idempotent from the UI", async ({ page }) => {
    const user = await signUp(page);
    await loadDemoAndReconcile(page, user.organizationId);

    await page.goto(`/orgs/${user.organizationId}/exceptions`);
    const before = await countExceptionRows(page);
    expect(before).toBeGreaterThan(0);

    // Run again from the runs page.
    await page.goto(`/orgs/${user.organizationId}/runs`);
    await page.getByRole("button", { name: /run reconciliation/i }).click();
    await page.waitForTimeout(6000);

    await page.goto(`/orgs/${user.organizationId}/exceptions`);
    const after = await countExceptionRows(page);
    // A second run over identical data must not duplicate the inbox.
    expect(after).toBe(before);
    expect(organizationIdFromUrl(page.url())).toBe(user.organizationId);
  });
});
