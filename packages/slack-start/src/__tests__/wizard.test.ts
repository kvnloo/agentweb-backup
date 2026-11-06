/**
 * ENG-2782 S2 — the Slack-start wizard, driven through the React adapter with
 * React Testing Library. The React component and the script-tag build share the
 * same Preact core, so these tests exercise the one wizard codebase.
 */
import { createElement } from 'react';
import { render, screen, waitFor, within, act, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SlackStartButton } from '../react';
import { createFakeApi } from './fakeApi';
import { closeAllSlackStart } from '../mount';

type Api = ReturnType<typeof createFakeApi>;
let api: Api;

function renderButton(props: Record<string, unknown> = {}) {
  return render(createElement(SlackStartButton, { apiBase: api.base, fetch: api.fetch, ...props }, 'Get started in Slack'));
}

const dialog = () => screen.getByRole('dialog');
const heading = () => within(dialog()).getByRole('heading', { level: 2 });
const continueBtn = () => within(dialog()).getByRole('button', { name: /continue|create my slack channel/i });

async function openWizard(user = userEvent.setup()) {
  renderButton();
  await user.click(screen.getByRole('button', { name: 'Get started in Slack' }));
  await screen.findByRole('heading', { name: "Let's set up your growth team" });
  return user;
}

async function finishStepOne(user: ReturnType<typeof userEvent.setup>) {
  await user.type(within(dialog()).getByLabelText('Work email'), 'sam@acme.co');
  await user.type(within(dialog()).getByLabelText('Company website'), 'acme.co');
  await user.click(continueBtn());
  await screen.findByRole('heading', { name: 'How did you find AgentWeb?' });
}

async function choose(user: ReturnType<typeof userEvent.setup>, labels: string[], nextHeading?: string) {
  for (const label of labels) await user.click(within(dialog()).getByLabelText(label));
  await user.click(continueBtn());
  if (nextHeading) await screen.findByRole('heading', { name: nextHeading });
}

beforeEach(() => {
  api = createFakeApi();
  sessionStorage.clear();
  window.history.replaceState(null, '', '/pricing?utm_source=linkedin&utm_campaign=launch');
});
afterEach(() => {
  closeAllSlackStart();
  cleanup();
});

describe('opening the wizard', () => {
  it('opens an accessible modal dialog rendered from the backend config', async () => {
    await openWizard();
    const d = dialog();
    expect(d.getAttribute('aria-modal')).toBe('true');
    expect(d.getAttribute('aria-labelledby')).toBe(heading().id);
    expect(within(d).getByText("We'll open a private Slack channel for you with our team and agents.")).toBeTruthy();
    expect(api.calls[0]).toMatchObject({ method: 'GET', path: '/api/onboarding/slack-start/config' });
    expect(within(d).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('1');
  });

  it('shows a retry when the config cannot load, and recovers', async () => {
    api.failNext((c) => c.path.endsWith('/config'), 503);
    const user = userEvent.setup();
    renderButton();
    await user.click(screen.getByRole('button', { name: 'Get started in Slack' }));
    const retry = await screen.findByRole('button', { name: /try again/i });
    await user.click(retry);
    await screen.findByRole('heading', { name: "Let's set up your growth team" });
  });
});

describe('step 1 — email and website', () => {
  it('POSTs immediately with an Idempotency-Key and page UTMs, keeps the capability out of the URL', async () => {
    const user = await openWizard();
    await finishStepOne(user);
    const post = api.calls.find((c) => c.method === 'POST')!;
    expect(post.path).toBe('/api/onboarding/slack-start');
    expect(post.body).toEqual({ email: 'sam@acme.co', website: 'acme.co', utm: { source: 'linkedin', campaign: 'launch' } });
    expect(post.headers['idempotency-key']).toMatch(/^[A-Za-z0-9-]{16,}$/);
    expect(window.location.search).toContain('aw_slack_step=2');
    expect(window.location.href).not.toContain('secret-token-abc');
    expect(window.location.href).not.toContain('intake-1');
  });

  it('shows the server error message for a duplicate company and stays on step 1', async () => {
    api.failNext((c) => c.method === 'POST', 409, { code: 'domain_in_progress', message: 'Someone from your company already started.' });
    const user = await openWizard();
    await user.type(within(dialog()).getByLabelText('Work email'), 'sam@acme.co');
    await user.type(within(dialog()).getByLabelText('Company website'), 'acme.co');
    await user.click(continueBtn());
    expect((await within(dialog()).findByRole('alert')).textContent).toBe('Someone from your company already started.');
    expect(heading().textContent).toBe("Let's set up your growth team");
  });

  it('maps a field error to the config copy', async () => {
    api.failNext((c) => c.method === 'POST', 400, { code: 'personal_email' });
    const user = await openWizard();
    await user.type(within(dialog()).getByLabelText('Work email'), 'sam@gmail.com');
    await user.type(within(dialog()).getByLabelText('Company website'), 'acme.co');
    await user.click(continueBtn());
    expect((await within(dialog()).findByRole('alert')).textContent).toBe('Please use your work email.');
  });

  it('retries a failed start with the SAME Idempotency-Key', async () => {
    api.failNext((c) => c.method === 'POST', 503, { code: 'provisioning_failed' });
    const user = await openWizard();
    await user.type(within(dialog()).getByLabelText('Work email'), 'sam@acme.co');
    await user.type(within(dialog()).getByLabelText('Company website'), 'acme.co');
    await user.click(continueBtn());
    await within(dialog()).findByRole('alert');
    await user.click(continueBtn());
    await screen.findByRole('heading', { name: 'How did you find AgentWeb?' });
    const posts = api.calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(2);
    expect(posts[0].headers['idempotency-key']).toBe(posts[1].headers['idempotency-key']);
  });
});

describe('steps 2–6', () => {
  it('PATCHes every step before continuing and advances the progress bar', async () => {
    const user = await openWizard();
    await finishStepOne(user);
    await choose(user, ['A friend or colleague'], "What's your role?");
    await choose(user, ['Founder / CEO'], 'What does your company sell?');
    await choose(user, ['SaaS / technology', 'E-commerce / DTC'], 'Which tools does your growth run on?');
    expect(within(dialog()).getByText(/Nothing gets connected here/)).toBeTruthy();
    await choose(user, ['Meta Ads', 'HubSpot'], 'How much do you spend on ads per month?');
    expect(within(dialog()).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('6');

    expect(api.patches().map((c) => c.body)).toEqual([
      { answers: { source: 'referral' }, step: 2 },
      { answers: { role: 'founder' }, step: 3 },
      { answers: { sector: ['saas', 'ecommerce'] }, step: 4 },
      { answers: { tools: ['meta_ads', 'hubspot'] }, step: 5 },
    ]);
    for (const c of api.patches()) expect(c.headers.authorization).toBe('Bearer secret-token-abc');
  });

  it('uses radio semantics for single-select and checkbox semantics for multi-select', async () => {
    const user = await openWizard();
    await finishStepOne(user);
    expect(within(dialog()).getAllByRole('radio')).toHaveLength(10);
    await choose(user, ['LinkedIn'], "What's your role?");
    await choose(user, ['Sales / RevOps'], 'What does your company sell?');
    expect(within(dialog()).getAllByRole('checkbox')).toHaveLength(6);
  });

  it('keeps Continue disabled until an option is chosen', async () => {
    const user = await openWizard();
    await finishStepOne(user);
    expect((continueBtn() as HTMLButtonElement).disabled).toBe(true);
    await user.click(within(dialog()).getByLabelText('Reddit'));
    expect((continueBtn() as HTMLButtonElement).disabled).toBe(false);
  });

  it('goes back with the back arrow and keeps the earlier selection', async () => {
    const user = await openWizard();
    await finishStepOne(user);
    await choose(user, ['Google'], "What's your role?");
    await user.click(within(dialog()).getByRole('button', { name: 'Back' }));
    await screen.findByRole('heading', { name: 'How did you find AgentWeb?' });
    expect((within(dialog()).getByLabelText('Google') as HTMLInputElement).checked).toBe(true);
    expect(window.location.search).toContain('aw_slack_step=2');
  });

  it('moves back a step on browser back (popstate)', async () => {
    const user = await openWizard();
    await finishStepOne(user);
    await choose(user, ['Google'], "What's your role?");
    await act(async () => {
      window.history.replaceState(null, '', '/pricing?aw_slack_step=2');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await screen.findByRole('heading', { name: 'How did you find AgentWeb?' });
  });

  it('shows a saving error with retry and does not advance until the PATCH succeeds', async () => {
    const user = await openWizard();
    await finishStepOne(user);
    api.failNext((c) => c.method === 'PATCH', 500);
    await user.click(within(dialog()).getByLabelText('Reddit'));
    await user.click(continueBtn());
    expect((await within(dialog()).findByRole('alert')).textContent).toMatch(/couldn't save/i);
    expect(heading().textContent).toBe('How did you find AgentWeb?');
    await user.click(within(dialog()).getByRole('button', { name: /try again/i }));
    await screen.findByRole('heading', { name: "What's your role?" });
  });

  it('back from step 2 shows step 1 read-only (the intake already exists)', async () => {
    const user = await openWizard();
    await finishStepOne(user);
    await user.click(within(dialog()).getByRole('button', { name: 'Back' }));
    await screen.findByRole('heading', { name: "Let's set up your growth team" });
    const email = within(dialog()).getByLabelText('Work email') as HTMLInputElement;
    expect(email.value).toBe('sam@acme.co');
    expect(email.readOnly).toBe(true);
    await user.click(continueBtn());
    await screen.findByRole('heading', { name: 'How did you find AgentWeb?' });
    expect(api.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });
});

describe('completion', () => {
  async function toLastStep() {
    const user = await openWizard();
    await finishStepOne(user);
    await choose(user, ['LinkedIn'], "What's your role?");
    await choose(user, ['Founder / CEO'], 'What does your company sell?');
    await choose(user, ['SaaS / technology'], 'Which tools does your growth run on?');
    await choose(user, ['Google Analytics'], 'How much do you spend on ads per month?');
    return user;
  }

  it('saves the budget, shows "getting ready", then an honest pending state while Slack invites are off', async () => {
    const user = await toLastStep();
    const releaseComplete = api.holdComplete();
    await user.click(within(dialog()).getByLabelText('$5k – $20k'));
    await user.click(continueBtn());
    await screen.findByRole('heading', { name: 'Your team is getting ready' });
    releaseComplete();
    await screen.findByRole('heading', { name: "You're on the list" });
    expect(dialog().textContent).not.toMatch(/invite (was|has been) sent|check slack/i);
    expect(api.patches().at(-1)!.body).toEqual({ answers: { adSpend: '5k_20k' }, step: 6 });
  });

  it('shows the ready state only when the backend reports a real invite', async () => {
    api.setComplete([{ status: 200, body: { intakeId: 'intake-1', status: 'invited', slackConnectStatus: 'created' } }]);
    const user = await toLastStep();
    await choose(user, ['Nothing yet']);
    await screen.findByRole('heading', { name: 'Check Slack' });
  });

  it('polls while another tab is completing (202 processing)', async () => {
    api.setComplete([
      { status: 202, body: { intakeId: 'intake-1', status: 'processing' } },
      { status: 200, body: { intakeId: 'intake-1', status: 'pending', slackConnectStatus: 'disabled' } },
    ]);
    const user = await toLastStep();
    await choose(user, ['Nothing yet']);
    await screen.findByRole('heading', { name: "You're on the list" }, { timeout: 4000 });
    expect(api.calls.filter((c) => c.path.endsWith('/complete'))).toHaveLength(2);
  });

  it('offers a retry when completion fails', async () => {
    api.setComplete([{ status: 500, body: { code: 'internal_error' } }]);
    const user = await toLastStep();
    await choose(user, ['Nothing yet']);
    await user.click(await within(dialog()).findByRole('button', { name: /try again/i }));
    await screen.findByRole('heading', { name: "You're on the list" });
  });
});

describe('dialog behavior', () => {
  it('closes on Escape and returns focus to the trigger', async () => {
    const user = await openWizard();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Get started in Slack' }));
    expect(window.location.search).not.toContain('aw_slack_step');
  });

  it('traps Tab focus inside the dialog', async () => {
    const user = await openWizard();
    for (let i = 0; i < 8; i++) {
      await user.tab();
      expect(dialog().contains(document.activeElement)).toBe(true);
    }
    await user.tab({ shift: true });
    expect(dialog().contains(document.activeElement)).toBe(true);
  });

  it('resumes a saved intake at its furthest step after a reload', async () => {
    const user = await openWizard();
    await finishStepOne(user);
    await choose(user, ['Reddit'], "What's your role?");
    closeAllSlackStart();
    cleanup();
    window.history.replaceState(null, '', '/pricing');

    renderButton();
    await user.click(screen.getByRole('button', { name: 'Get started in Slack' }));
    await screen.findByRole('heading', { name: "What's your role?" });
    expect(api.calls.some((c) => c.method === 'GET' && c.path === '/api/onboarding/slack-start/intake-1')).toBe(true);
  });

  it('starts fresh when the saved intake is no longer valid', async () => {
    sessionStorage.setItem(
      'aw-slack-start:https://api.test',
      JSON.stringify({ intakeId: 'intake-1', intakeToken: 'stale', idempotencyKey: 'k'.repeat(20), email: 'a@b.co', website: 'b.co' }),
    );
    const user = userEvent.setup();
    renderButton();
    await user.click(screen.getByRole('button', { name: 'Get started in Slack' }));
    await screen.findByRole('heading', { name: "Let's set up your growth team" });
    expect(sessionStorage.getItem('aw-slack-start:https://api.test')).toBeNull();
  });
});
