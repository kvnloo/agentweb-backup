/**
 * Tests for the admin "Vendor Rates" tab (components/admin/VendorRatesTab.tsx, ENG-2271).
 * Mocks follow the V0CreditsCard.test.tsx conventions; the API shape is the
 * vendor-rate override contract (GET/PUT /api/admin/vendor-rates).
 */

import React from 'react';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
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
const input = () => screen.getByLabelText('New price for twilio/voice_outbound_minute');

async function renderLoaded(data = baseResponse(null)) {
  mockedGet.mockResolvedValue({ data });
  render(<VendorRatesTab />);
  await screen.findByTestId(ROW);
}

describe('VendorRatesTab', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders rate rows with unit and sub-cent prices from the GET response', async () => {
    await renderLoaded(baseResponse(0.02));

    expect(mockedGet).toHaveBeenCalledWith(URL, HEADERS);
    expect(screen.getByTestId('vendor-rates-version')).toHaveTextContent('v1+ovr:2026-10-19T00:00:00.000Z');
    const row = within(screen.getByTestId(ROW));
    expect(row.getByText('minute')).toBeInTheDocument();
    expect(row.getByText('$0.014')).toBeInTheDocument(); // default, not rounded to cents
    expect(row.getAllByText('$0.02')).toHaveLength(2); // override and effective
    expect(within(screen.getByTestId('vendor-rate-row-twilio/sms_segment')).getAllByText('$0.0083')).toHaveLength(2); // default and effective
    expect(screen.getByLabelText('USD per minute', { selector: 'input' })).toBeInTheDocument();
  });

  it('shows a loading spinner until the GET resolves', async () => {
    mockedGet.mockReturnValue(new Promise(() => {}));
    render(<VendorRatesTab />);
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
  });

  it('shows the server error message when loading fails', async () => {
    mockedGet.mockRejectedValue({ response: { data: { error: 'boom from server' } } });
    render(<VendorRatesTab />);
    expect(await screen.findByText('boom from server')).toBeInTheDocument();
  });

  it('shows an empty state when there are no editable providers', async () => {
    mockedGet.mockResolvedValue({ data: { ...baseResponse(null), editableProviders: [], rates: [] } });
    render(<VendorRatesTab />);
    expect(await screen.findByText('No editable vendor rates.')).toBeInTheDocument();
  });

  it('sends the exact PUT body on save and updates the row from the response', async () => {
    await renderLoaded();
    mockedPut.mockResolvedValue({ data: baseResponse(0.02) });

    fireEvent.change(input(), { target: { value: ' 0.02 ' } });
    fireEvent.click(within(screen.getByTestId(ROW)).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mockedPut).toHaveBeenCalledTimes(1));
    expect(mockedPut).toHaveBeenCalledWith(
      URL,
      { provider: 'twilio', key: 'voice_outbound_minute', usdPerUnit: 0.02 },
      HEADERS,
    );
    expect(await screen.findByText('twilio/voice_outbound_minute saved')).toBeInTheDocument();
    expect(within(screen.getByTestId(ROW)).getAllByText('$0.02')).toHaveLength(2);
    expect(screen.getByTestId('vendor-rates-version')).toHaveTextContent('+ovr:');
    expect(input()).toHaveValue('');
  });

  it('resets to default by PUTting usdPerUnit null', async () => {
    await renderLoaded(baseResponse(0.02));
    mockedPut.mockResolvedValue({ data: baseResponse(null) });

    fireEvent.click(within(screen.getByTestId(ROW)).getByRole('button', { name: 'Reset to default' }));

    await waitFor(() => expect(mockedPut).toHaveBeenCalledTimes(1));
    expect(mockedPut).toHaveBeenCalledWith(
      URL,
      { provider: 'twilio', key: 'voice_outbound_minute', usdPerUnit: null },
      HEADERS,
    );
    await waitFor(() => expect(screen.getByTestId('vendor-rates-version')).toHaveTextContent('Rate card version: v1'));
    expect(within(screen.getByTestId(ROW)).getByRole('button', { name: 'Reset to default' })).toBeDisabled();
  });

  it('disables reset when there is no override', async () => {
    await renderLoaded();
    expect(within(screen.getByTestId(ROW)).getByRole('button', { name: 'Reset to default' })).toBeDisabled();
  });

  it.each(['0', '-1', 'NaN', 'abc', '1000.01', 'Infinity', '1e999', '0x10x'])(
    'blocks invalid price %p client-side without calling PUT',
    async (bad) => {
      await renderLoaded();

      fireEvent.change(input(), { target: { value: bad } });
      fireEvent.click(within(screen.getByTestId(ROW)).getByRole('button', { name: 'Save' }));

      expect(await screen.findByText(/greater than 0 and at most 1000/)).toBeInTheDocument();
      expect(mockedPut).not.toHaveBeenCalled();
    },
  );

  it('accepts the upper bound 1000', async () => {
    await renderLoaded();
    mockedPut.mockResolvedValue({ data: baseResponse(1000) });

    fireEvent.change(input(), { target: { value: '1000' } });
    fireEvent.click(within(screen.getByTestId(ROW)).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mockedPut).toHaveBeenCalledTimes(1));
    expect(mockedPut.mock.calls[0][1].usdPerUnit).toBe(1000);
  });

  it('surfaces a server 400 error and keeps the typed draft', async () => {
    await renderLoaded();
    mockedPut.mockRejectedValue({ response: { status: 400, data: { error: 'usdPerUnit must be <= 1000' } } });

    fireEvent.change(input(), { target: { value: '5' } });
    fireEvent.click(within(screen.getByTestId(ROW)).getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('usdPerUnit must be <= 1000')).toBeInTheDocument();
    expect(input()).toHaveValue('5');
  });

  it('disables all controls while a save is in flight', async () => {
    await renderLoaded(baseResponse(0.02));
    let resolvePut: (v: unknown) => void = () => {};
    mockedPut.mockReturnValue(new Promise((r) => { resolvePut = r; }));

    fireEvent.change(input(), { target: { value: '5' } });
    fireEvent.click(within(screen.getByTestId(ROW)).getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('button', { name: 'Saving...' })).toBeDisabled();
    expect(input()).toBeDisabled();
    expect(within(screen.getByTestId(ROW)).getByRole('button', { name: 'Reset to default' })).toBeDisabled();
    expect(screen.getByLabelText('New price for twilio/sms_segment')).toBeDisabled();

    resolvePut({ data: baseResponse(5) });
    await waitFor(() => expect(input()).not.toBeDisabled());
  });
});
