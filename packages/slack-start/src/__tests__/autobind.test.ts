/**
 * ENG-2782 S2 — the script-tag build binds ANY [data-agentweb-slack-start]
 * element, including ones a framework renders after the script loaded.
 */
import { screen, within, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { autoBind, closeAllSlackStart, resolveApiBase } from '../mount';
import { createFakeApi } from './fakeApi';

let api: ReturnType<typeof createFakeApi>;
let stop: (() => void) | undefined;

beforeEach(() => {
  api = createFakeApi();
  sessionStorage.clear();
  document.body.innerHTML = '';
});
afterEach(() => {
  stop?.();
  closeAllSlackStart();
  cleanup();
});

it('binds elements present at load', async () => {
  document.body.innerHTML = '<a href="#" data-agentweb-slack-start>Start</a>';
  stop = autoBind({ apiBase: api.base, fetch: api.fetch });
  await userEvent.setup().click(screen.getByText('Start'));
  await screen.findByRole('heading', { name: "Let's set up your growth team" });
});

it('binds elements added to the page later', async () => {
  stop = autoBind({ apiBase: api.base, fetch: api.fetch });
  const late = document.createElement('button');
  late.setAttribute('data-agentweb-slack-start', '');
  late.textContent = 'Late button';
  document.body.appendChild(late);
  await waitFor(() => expect(late.getAttribute('aria-haspopup')).toBe('dialog'));
  await userEvent.setup().click(late);
  const dialog = await screen.findByRole('dialog');
  expect(await within(dialog).findByRole('heading', { name: "Let's set up your growth team" })).toBeTruthy();
});

it('binds each element once even if autoBind runs twice', async () => {
  document.body.innerHTML = '<button data-agentweb-slack-start>Once</button>';
  stop = autoBind({ apiBase: api.base, fetch: api.fetch });
  const again = autoBind({ apiBase: api.base, fetch: api.fetch });
  await userEvent.setup().click(screen.getByText('Once'));
  await screen.findByRole('dialog');
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  again();
});

it('lets an element override the API base with data-api-base', () => {
  const el = document.createElement('button');
  el.setAttribute('data-api-base', 'https://api-stage.agentweb.pro/');
  expect(resolveApiBase(el, 'https://api.agentweb.pro')).toBe('https://api-stage.agentweb.pro');
  expect(resolveApiBase(document.createElement('button'), 'https://api.agentweb.pro')).toBe('https://api.agentweb.pro');
});
