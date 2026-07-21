import { expect, type Page } from "@playwright/test";

/**
 * End-to-end helpers.
 *
 * Selectors prefer accessible roles and visible text over CSS classes: if a test
 * can no longer find a control by its label, a real user using a screen reader
 * probably cannot either.
 */

let counter = 0;

export function uniqueEmail(prefix = "e2e"): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.test`;
}

export const TEST_PASSWORD = "correct-horse-battery-staple-42";

export interface SignedUpUser {
  email: string;
  organizationName: string;
  organizationId: string;
}

/**
 * Register a new user with their own organization and land inside the app.
 * Returns the organization id parsed from the resulting URL.
 */
export async function signUp(
  page: Page,
  options: { email?: string; organizationName?: string; name?: string } = {},
): Promise<SignedUpUser> {
  const email = options.email ?? uniqueEmail();
  const organizationName = options.organizationName ?? `Acme ${Date.now()}`;
  const name = options.name ?? "Test Operator";

  await page.goto("/sign-up");

  await page.getByLabel(/name/i).first().fill(name);
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).fill(TEST_PASSWORD);

  const orgField = page.getByLabel(/organization/i);
  if (await orgField.count()) await orgField.first().fill(organizationName);

  await page.getByRole("button", { name: /create account|sign up/i }).click();

  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}/, { timeout: 30_000 });
  const organizationId = organizationIdFromUrl(page.url());

  return { email, organizationName, organizationId };
}

export async function signIn(page: Page, email: string): Promise<void> {
  await page.goto("/sign-in");
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).fill(TEST_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}/, { timeout: 30_000 });
}

export function organizationIdFromUrl(url: string): string {
  const match = /\/orgs\/([0-9a-f-]{36})/.exec(url);
  if (!match?.[1]) throw new Error(`No organization id in URL: ${url}`);
  return match[1];
}

/**
 * Load the demo dataset and run reconciliation, then wait for exceptions to
 * appear.
 *
 * Reconciliation genuinely runs in the worker, so the UI is polled rather than
 * assumed to be immediately consistent — which is exactly what a real operator
 * experiences.
 */
export async function loadDemoAndReconcile(page: Page, organizationId: string): Promise<void> {
  await page.goto(`/orgs/${organizationId}`);

  const loadButton = page.getByRole("button", { name: /load demo data/i });
  await expect(loadButton).toBeVisible();
  await loadButton.click();

  await waitForExceptions(page, organizationId);
}

/**
 * Count exception rows on the inbox page.
 *
 * Targets `tbody tr` rather than the `row` role: the role also matches the
 * header row and any row in an unrelated table on the page, which makes an
 * off-by-one or a false positive far too easy.
 */
export async function countExceptionRows(page: Page): Promise<number> {
  return page.locator("table tbody tr").count();
}

/** Poll the exception list until the background run has produced results. */
export async function waitForExceptions(
  page: Page,
  organizationId: string,
  minimum = 1,
): Promise<number> {
  const deadline = Date.now() + 90_000;

  for (;;) {
    await page.goto(`/orgs/${organizationId}/exceptions`);
    const count = await countExceptionRows(page);
    if (count >= minimum) return count;

    if (Date.now() > deadline) {
      // Include what the page actually said: "0 rows" is not a diagnosis, but
      // "no reconciliation has run yet" versus "no results for these filters"
      // points straight at the cause.
      const visible = await page
        .locator("main")
        .innerText()
        .catch(() => "(no main element)");
      throw new Error(
        `Timed out waiting for at least ${minimum} exception(s) for organization ${organizationId}.\n` +
          `Is the worker running and processing reconciliation jobs?\n` +
          `Page content was:\n${visible.slice(0, 1200)}`,
      );
    }
    await page.waitForTimeout(2000);
  }
}
