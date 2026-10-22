/**
 * Tests for the admin "Vendor Rates" tab (components/admin/VendorRatesTab.tsx, ENG-2271).
 * Mocks follow the V0CreditsCard.test.tsx conventions; the API shape is the
 * vendor-rate override contract (GET/PUT /api/admin/vendor-rates).
 */

import React from 'react';
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('axios', () => ({
  get: jest.fn(),
  put: jest.fn(),
}));

jest.mock('../config', () => ({
  buildApiUrl: (path: string) => `http://localhost:3001${path}`,
}));

jest.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ token: 'test-token' }),
}));

import VendorRatesTab from '../components/admin/VendorRatesTab';
import axios from 'axios';

const mockedGet = axios.get as jest.Mock;
const mockedPut = axios.put as jest.Mock;

const URL = 'http://localhost:3001/api/admin/vendor-rates';
const HEADERS = { headers: { Authorization: 'Bearer test-token' } };

const baseResponse = (overrideUsd: number | null) => ({
  version: overrideUsd === null ? 'v1' : 'v1+ovr:2026-10-19T00:00:00.000Z',
  editableProviders: ['twilio'],
  rates: [
    {
      provider: 'twilio',
      key: 'voice_outbound_minute',
      unit: 'minute',
      defaultUsdPerUnit: 0.014,
      overrideUsdPerUnit: overrideUsd,
      effectiveUsdPerUnit: overrideUsd ?? 0.014,
    },
    {
      provider: 'twilio',
      key: 'sms_segment',
      unit: 'segment',
      defaultUsdPerUnit: 0.0083,
      overrideUsdPerUnit: null,
      effectiveUsdPerUnit: 0.0083,
    },
  ],
  updatedAt: overrideUsd === null ? null : '2026-10-19T00:00:00.000Z',
  updatedBy: overrideUsd === null ? null : 'admin-1',
});

const ROW = 'vendor-rate-row-twilio/voice_outbound_minute';
// hidden: true because MUI marks the page aria-hidden while the dialog is open or
// still closing, which would hide the buttons from role queries.
const saveBtn = () => screen.getByRole('button', { name: 'Save twilio voice_outbound_minute', hidden: true });
const resetBtn = () => screen.getByRole('button', { name: 'Reset twilio voice_outbound_minute to default', hidden: true });
const confirmBtn = () => within(screen.getByRole('dialog')).getByRole('button', { name: 'Confirm' });
const input = () => screen.getByLabelText('New price for twilio/voice_outbound_minute');

async function renderLoaded(data = baseResponse(null)) {
  mockedGet.mockResolvedValue({ data });
  render(<VendorRatesTab />);
  await screen.findByTestId(ROW);
}

const sub = (n: number) => ({ ...baseResponse(null), rates: [{ ...baseResponse(null).rates[0], defaultUsdPerUnit: n, effectiveUsdPerUnit: n }] });

describe('VendorRatesTab', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders rate rows with unit and sub-cent prices from the GET response', async () => {
    await renderLoaded(baseResponse(0.02));

    expect(mockedGet).toHaveBeenCalledWith(URL, HEADERS);
    expect(screen.getByTestId('vendor-rates-version')).toHaveTextContent('v1+ovr:2026-10-19T00:00:00.000Z');
    expect(screen.getByTestId('vendor-rates-version')).toHaveTextContent('Last changed by admin-1 at 2026-10-19T00:00:00.000Z');
    const row = within(screen.getByTestId(ROW));
    expect(row.getByText('minute')).toBeInTheDocument();
    expect(row.getByText('$0.014')).toBeInTheDocument();
    expect(row.getAllByText('$0.02')).toHaveLength(2);
    expect(within(screen.getByTestId('vendor-rate-row-twilio/sms_segment')).getAllByText('$0.0083')).toHaveLength(2);
    expect(screen.getByLabelText('USD per minute', { selector: 'input' })).toBeInTheDocument();
  });

  it.each([
    [0.000001, '$0.000001'],
    [0.000123, '$0.000123'],
    [0.014, '$0.014'],
    [0.5, '$0.50'],
    [12, '$12.00'],
    [1000, '$1000.00'],
    [123.456789, '$123.456789'],
    [0.000000001, '$0.000000001'],
  ])('displays stored price %p exactly as %p, never $0.00', async (n, shown) => {
    await renderLoaded(sub(n));
    const row = within(screen.getByTestId(ROW));
    expect(row.getAllByText(shown).length).toBeGreaterThan(0);
    expect(row.queryByText('$0.00')).not.toBeInTheDocument();
  });

  it('labels the loading spinner', async () => {
    mockedGet.mockReturnValue(new Promise(() => {}));
    render(<VendorRatesTab />);
    expect(screen.getByRole('progressbar', { name: 'Loading vendor rates' })).toBeInTheDocument();
  });

  it('shows the server error message when loading fails, persistently, with Retry', async () => {
    jest.useFakeTimers();
    try {
      mockedGet.mockRejectedValue({ response: { status: 500, data: { error: 'boom from server' } } });
      render(<VendorRatesTab />);
      expect(await screen.findByText('boom from server')).toBeInTheDocument();
      act(() => { jest.advanceTimersByTime(10000); });
      expect(screen.getByText('boom from server')).toBeInTheDocument();
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([
    ['401', { response: { status: 401, data: { error: 'Unauthorized' } } }, 'Unauthorized'],
    ['403', { response: { status: 403, data: { error: 'Admin access required' } } }, 'Admin access required'],
    ['network error', new Error('Network Error'), 'Failed to load vendor rates'],
    ['5xx without body', { response: { status: 503, data: '<html>' } }, 'Failed to load vendor rates'],
  ])('load failure %s shows an error with Retry', async (_n, rejection, text) => {
    mockedGet.mockRejectedValue(rejection);
    render(<VendorRatesTab />);
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it.each([
    ['an HTML string', '<!doctype html><html></html>'],
    ['an empty object', {}],
    ['null rates', { ...baseResponse(null), rates: null }],
    ['null body', null],
    ['a row with a string price', { ...baseResponse(null), rates: [{ ...baseResponse(null).rates[0], defaultUsdPerUnit: '0.014' }] }],
    ['a missing version', { ...baseResponse(null), version: undefined }],
    ['non-array providers', { ...baseResponse(null), editableProviders: 'twilio' }],
  ])('treats %s as a load error without throwing', async (_n, payload) => {
    mockedGet.mockResolvedValue({ data: payload });
    render(<VendorRatesTab />);
    expect(await screen.findByText(/unexpected response from server/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('Retry reloads and renders the table', async () => {
    mockedGet.mockRejectedValueOnce(new Error('Network Error')).mockResolvedValueOnce({ data: baseResponse(null) });
    render(<VendorRatesTab />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId(ROW)).toBeInTheDocument();
    expect(screen.queryByText('Failed to load vendor rates')).not.toBeInTheDocument();
  });

  it('shows an empty state when there are no editable providers', async () => {
    mockedGet.mockResolvedValue({ data: { ...baseResponse(null), editableProviders: [], rates: [] } });
    render(<VendorRatesTab />);
    expect(await screen.findByText('No editable vendor rates.')).toBeInTheDocument();
  });

  it('asks for confirmation, then sends the exact PUT body and updates the row', async () => {
    await renderLoaded();
    mockedPut.mockResolvedValue({ data: baseResponse(0.02) });

    fireEvent.change(input(), { target: { value: ' 0.02 ' } });
    fireEvent.click(saveBtn());

    expect(mockedPut).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('twilio/voice_outbound_minute: $0.014 -> $0.02 per minute (x1.4)');
    fireEvent.click(confirmBtn());

    await waitFor(() => expect(mockedPut).toHaveBeenCalledTimes(1));
    expect(mockedPut).toHaveBeenCalledWith(URL, { provider: 'twilio', key: 'voice_outbound_minute', usdPerUnit: 0.02 }, HEADERS);
    expect(await screen.findByText('twilio/voice_outbound_minute saved')).toBeInTheDocument();
    expect(within(screen.getByTestId(ROW)).getAllByText('$0.02')).toHaveLength(2);
    expect(screen.getByTestId('vendor-rates-version')).toHaveTextContent('+ovr:');
    expect(input()).toHaveValue('');
  });

  it('Cancel sends nothing and keeps the draft', async () => {
    await renderLoaded();
    fireEvent.change(input(), { target: { value: '0.02' } });
    fireEvent.click(saveBtn());
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(mockedPut).not.toHaveBeenCalled();
    expect(input()).toHaveValue('0.02');
  });

  it('Enter in the field opens the confirmation', async () => {
    await renderLoaded();
    fireEvent.change(input(), { target: { value: '0.02' } });
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(mockedPut).not.toHaveBeenCalled();
  });

  it.each([
    ['0.14', 'x10.0', false], // exactly 10x: no warning
    ['0.15', 'x10.7', true],
    ['0.0014', '/10.0', false], // exactly 0.1x: no warning
    ['0.0013', '/10.8', true],
    ['0.014', 'x1.0', false],
  ])('confirm for %s shows %s, warning=%s', async (value, multiple, warns) => {
    await renderLoaded();
    fireEvent.change(input(), { target: { value } });
    fireEvent.click(saveBtn());
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent(`(${multiple})`);
    expect(within(dialog).queryByText(/more than 10x/) !== null).toBe(warns);
  });

  it('reset confirm shows effective and default, then PUTs null', async () => {
    await renderLoaded(baseResponse(0.02));
    mockedPut.mockResolvedValue({ data: baseResponse(null) });

    fireEvent.click(resetBtn());
    expect(mockedPut).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('twilio/voice_outbound_minute: $0.02 -> $0.014 per minute');
    expect(dialog).toHaveTextContent('Returns to the default rate of $0.014 per minute.');
    fireEvent.click(confirmBtn());

    await waitFor(() => expect(mockedPut).toHaveBeenCalledTimes(1));
    expect(mockedPut).toHaveBeenCalledWith(URL, { provider: 'twilio', key: 'voice_outbound_minute', usdPerUnit: null }, HEADERS);
    await waitFor(() => expect(screen.getByTestId('vendor-rates-version')).toHaveTextContent('Rate card version (overridden rates): v1'));
    expect(resetBtn()).toBeDisabled();
  });

  it('disables reset when there is no override', async () => {
    await renderLoaded();
    expect(resetBtn()).toBeDisabled();
  });

  it.each(['0', '-1', 'NaN', 'abc', '10.01', '14', 'Infinity', '1e999', '0x10', '0b1', '0o7', '1e-3', '+1', '1,5', '.', '1.1234567', '0.0000001'])(
    'blocks invalid price %p client-side without a dialog or PUT',
    async (bad) => {
      await renderLoaded();
      fireEvent.change(input(), { target: { value: bad } });
      fireEvent.keyDown(input(), { key: 'Enter' });
      expect(await screen.findByText(/plain decimal greater than 0/)).toBeInTheDocument();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(mockedPut).not.toHaveBeenCalled();
    },
  );

  it.each(['', '  '])('keeps Save disabled and ignores Enter for empty input %p', async (empty) => {
    await renderLoaded();
    fireEvent.change(input(), { target: { value: empty } });
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(saveBtn()).toBeDisabled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mockedPut).not.toHaveBeenCalled();
  });

  it.each([['0.014', 0.014], ['.5', 0.5], ['5.', 5], ['0.000001', 0.000001], ['10', 10]])(
    'accepts plain decimal %p and sends %p',
    async (typed, sent) => {
      await renderLoaded();
      mockedPut.mockResolvedValue({ data: baseResponse(sent) });
      fireEvent.change(input(), { target: { value: typed } });
      fireEvent.click(saveBtn());
      fireEvent.click(confirmBtn());
      await waitFor(() => expect(mockedPut).toHaveBeenCalledTimes(1));
      expect(mockedPut.mock.calls[0][1].usdPerUnit).toBe(sent);
    },
  );

  it('surfaces a server 400 error persistently and keeps the typed draft', async () => {
    jest.useFakeTimers();
    try {
      await renderLoaded();
      mockedPut.mockRejectedValue({ response: { status: 400, data: { error: 'usdPerUnit must be <= 10' } } });
      fireEvent.change(input(), { target: { value: '5' } });
      fireEvent.click(saveBtn());
      fireEvent.click(confirmBtn());

      expect(await screen.findByText('usdPerUnit must be <= 10')).toBeInTheDocument();
      act(() => { jest.advanceTimersByTime(10000); });
      expect(screen.getByText('usdPerUnit must be <= 10')).toBeInTheDocument();
      expect(input()).toHaveValue('5');
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([
    ['403 with message', { response: { status: 403, data: { error: 'Admin access required' } } }, 'Admin access required'],
    ['network error', new Error('Network Error'), 'Failed to save vendor rate'],
  ])('save failure (%s) shows the server error or the fallback', async (_n, rejection, text) => {
    await renderLoaded();
    mockedPut.mockRejectedValue(rejection);
    fireEvent.change(input(), { target: { value: '5' } });
    fireEvent.click(saveBtn());
    fireEvent.click(confirmBtn());
    expect(await screen.findByText(text)).toBeInTheDocument();
  });

  it('treats a malformed PUT response as a save error and keeps the table', async () => {
    await renderLoaded();
    mockedPut.mockResolvedValue({ data: '<html>' });
    fireEvent.change(input(), { target: { value: '5' } });
    fireEvent.click(saveBtn());
    fireEvent.click(confirmBtn());
    expect(await screen.findByText(/unexpected response from server/)).toBeInTheDocument();
    expect(screen.getByTestId(ROW)).toBeInTheDocument();
  });

  it('leaves the other row and its draft untouched after saving one row', async () => {
    await renderLoaded();
    mockedPut.mockResolvedValue({ data: baseResponse(0.02) });
    const other = screen.getByLabelText('New price for twilio/sms_segment');
    fireEvent.change(other, { target: { value: '0.009' } });
    fireEvent.change(input(), { target: { value: '0.02' } });
    fireEvent.click(saveBtn());
    fireEvent.click(confirmBtn());
    await screen.findByText('twilio/voice_outbound_minute saved');
    expect(other).toHaveValue('0.009');
    expect(within(screen.getByTestId('vendor-rate-row-twilio/sms_segment')).getAllByText('$0.0083')).toHaveLength(2);
  });

  it.each([['Escape', (d: HTMLElement) => fireEvent.keyDown(d, { key: 'Escape' })],
    ['backdrop click', () => fireEvent.click(document.querySelector('.MuiBackdrop-root') as Element)]])(
    'dismissing the dialog with %s sends nothing and keeps the draft', async (_n, dismiss) => {
      await renderLoaded();
      fireEvent.change(input(), { target: { value: '0.02' } });
      fireEvent.click(saveBtn());
      dismiss(screen.getByRole('dialog'));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(mockedPut).not.toHaveBeenCalled();
      expect(input()).toHaveValue('0.02');
    });

  it('a double-click on Confirm sends exactly one PUT', async () => {
    await renderLoaded();
    mockedPut.mockResolvedValue({ data: baseResponse(0.02) });
    fireEvent.change(input(), { target: { value: '0.02' } });
    fireEvent.click(saveBtn());
    const confirm = confirmBtn();
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await screen.findByText('twilio/voice_outbound_minute saved');
    expect(mockedPut).toHaveBeenCalledTimes(1);
  });

  it('auto-clears the success message after 4 seconds', async () => {
    jest.useFakeTimers();
    try {
      await renderLoaded();
      mockedPut.mockResolvedValue({ data: baseResponse(0.02) });
      fireEvent.change(input(), { target: { value: '0.02' } });
      fireEvent.click(saveBtn());
      fireEvent.click(confirmBtn());
      expect(await screen.findByText('twilio/voice_outbound_minute saved')).toBeInTheDocument();
      act(() => { jest.advanceTimersByTime(3900); });
      expect(screen.getByText('twilio/voice_outbound_minute saved')).toBeInTheDocument();
      act(() => { jest.advanceTimersByTime(200); });
      expect(screen.queryByText('twilio/voice_outbound_minute saved')).not.toBeInTheDocument();
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps the reset dialog title and body while it closes', async () => {
    await renderLoaded(baseResponse(0.02));
    fireEvent.click(resetBtn());
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(dialog).toHaveTextContent('Confirm reset to default');
    expect(dialog).toHaveTextContent('Returns to the default rate');
  });

  it('survives an object-valued server error and a non-string updatedBy', async () => {
    mockedGet.mockRejectedValueOnce({ response: { status: 502, data: { error: { message: 'bad gateway' } } } });
    render(<VendorRatesTab />);
    expect(await screen.findByText('Failed to load vendor rates')).toBeInTheDocument();

    mockedGet.mockResolvedValueOnce({ data: { ...baseResponse(0.02), updatedBy: 42 } });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/unexpected response from server/)).toBeInTheDocument();
  });

  it('makes inputs read-only and disables buttons while a save is in flight', async () => {
    await renderLoaded(baseResponse(0.02));
    let resolvePut: (v: unknown) => void = () => {};
    mockedPut.mockReturnValue(new Promise((r) => { resolvePut = r; }));

    fireEvent.change(input(), { target: { value: '5' } });
    fireEvent.click(saveBtn());
    fireEvent.click(confirmBtn());

    expect(await screen.findByText('Saving...')).toBeInTheDocument();
    expect(saveBtn()).toBeDisabled();
    expect(input()).toHaveAttribute('readonly');
    expect(input()).not.toBeDisabled();
    expect(resetBtn()).toBeDisabled();
    expect(screen.getByLabelText('New price for twilio/sms_segment')).toHaveAttribute('readonly');

    resolvePut({ data: baseResponse(5) });
    await waitFor(() => expect(input()).not.toHaveAttribute('readonly'));
  });
});
