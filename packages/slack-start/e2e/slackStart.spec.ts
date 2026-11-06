/**
 * ENG-2782 S2 — real-browser runs of the built script-tag bundle (dist/slack-start.js)
 * with the backend API mocked at the network layer.
 */
import { expect, test, type Page } from '@playwright/test';
import { mockSlackStartApi } from './mockApi';

const dialog = (page: Page) => page.getByRole('dialog');

async function pick(page: Page, labels: string[], next: string) {
  for (const l of labels) await dialog(page).getByText(l, { exact: true }).click();
  await dialog(page).getByRole('button', { name: /continue|create my slack channel/i }).click();
  await expect(dialog(page).getByRole('heading', { level: 2 })).toHaveText(next);
}

test('full happy path through all six steps to an honest pending state', async ({ page }) => {
  const calls = await mockSlackStartApi(page);
  const consoleErrors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  await page.goto('/static.html?utm_source=reddit');

  await page.getByRole('button', { name: 'Get started in Slack' }).click();
  await expect(dialog(page).getByRole('heading', { level: 2 })).toHaveText("Let's set up your growth team");
  await dialog(page).getByLabel('Work email').fill('sam@acme.co');
  await dialog(page).getByLabel('Company website').fill('acme.co');
  await dialog(page).getByRole('button', { name: /continue/i }).click();
  await expect(dialog(page).getByRole('heading', { level: 2 })).toHaveText('How did you find AgentWeb?');
  expect(page.url()).toContain('aw_slack_step=2');
  expect(page.url()).not.toContain('e2e-token');

  await pick(page, ['Slack Marketplace'], "What's your role?");
  await pick(page, ['Head of Marketing / Growth'], 'What does your company sell?');

  // Browser back returns to the previous step with its answer kept.
  await page.goBack();
  await expect(dialog(page).getByRole('heading', { level: 2 })).toHaveText("What's your role?");
  await expect(dialog(page).getByLabel('Head of Marketing / Growth')).toBeChecked();
  await dialog(page).getByRole('button', { name: /continue/i }).click();

  await pick(page, ['Agency / freelance – serve multiple clients', 'SaaS / technology'], 'Which tools does your growth run on?');
  await pick(page, ['Google Ads', 'Shopify'], 'How much do you spend on ads per month?');
  await pick(page, ['$100k+'], "You're on the list");
  await expect(dialog(page)).not.toContainText(/invite (was|has been) sent/i);

  const start = calls.find((c) => c.method === 'POST' && c.path === '/api/onboarding/slack-start')!;
  expect(start.body).toEqual({ email: 'sam@acme.co', website: 'acme.co', utm: { source: 'reddit' } });
  expect(start.headers['idempotency-key']).toBeTruthy();
  expect(calls.filter((c) => c.method === 'PATCH').map((c) => Object.keys(c.body.answers)[0])).toEqual([
    'source', 'role', 'role', 'sector', 'tools', 'adSpend',
  ]);
  expect(calls.filter((c) => c.path.endsWith('/complete'))).toHaveLength(1);
  expect(consoleErrors).toEqual([]);

  await dialog(page).getByRole('button', { name: 'Close' }).last().click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Get started in Slack' })).toBeFocused();
});

test('binds a trigger that a framework adds after the script loaded', async ({ page }) => {
  await mockSlackStartApi(page);
  await page.goto('/dynamic.html');
  const late = page.getByText('Start in Slack (late)');
  await expect(late).toHaveAttribute('aria-haspopup', 'dialog');
  await late.click();
  await expect(dialog(page)).toHaveAttribute('aria-modal', 'true');
  await expect(dialog(page).getByRole('heading', { level: 2 })).toHaveText("Let's set up your growth team");
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
});

test('resumes the saved intake after a full page reload', async ({ page }) => {
  await mockSlackStartApi(page);
  await page.goto('/static.html');
  await page.getByRole('button', { name: 'Get started in Slack' }).click();
  await dialog(page).getByLabel('Work email').fill('sam@acme.co');
  await dialog(page).getByLabel('Company website').fill('acme.co');
  await dialog(page).getByRole('button', { name: /continue/i }).click();
  await pick(page, ['Google'], "What's your role?");
  await page.reload();
  await page.getByRole('button', { name: 'Get started in Slack' }).click();
  await expect(dialog(page).getByRole('heading', { level: 2 })).toHaveText("What's your role?");
});
