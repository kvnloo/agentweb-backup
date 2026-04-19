/**
 * Tests for the Partner Portal `/drip-campaigns` admin page.
 * Verifies list/empty-state rendering, new-campaign dialog, kill-switch
 * toggle, and preview — all against a mocked axios.
 */
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axios from 'axios';
import DripCampaigns from '../pages/DripCampaigns';
import '@testing-library/jest-dom';

// Mock config so jest can import the page without hitting import.meta.env
jest.mock('../config', () => ({
  API_URL: 'http://localhost:3001',
  DEBUG: false,
}));

// Mock axios
jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

jest.mock('../contexts/AuthContext', () => {
  const actual = jest.requireActual('../contexts/AuthContext');
  return {
    ...actual,
    useAuth: () => ({
      token: 'mock-token',
      user: { userId: 'admin-1', isAdmin: true },
      login: jest.fn(),
      logout: jest.fn(),
      isAuthenticated: true,
    }),
  };
});

const sampleCampaign = {
  campaignId: 'cmp-1',
  name: 'Brand step recovery',
  subjectLine: 'Emma is waiting',
  templateHtml: '<p>Hi {{firstName}}.</p>',
  segmentQuery: { stage: 'brand_skipped' },
  cadenceUnit: 'days' as const,
  cadenceValue: 7,
  maxSends: 3,
  isActive: true,
  killSwitch: false,
  createdBy: 'admin-1',
  createdAt: '2026-04-19T00:00:00Z',
  updatedAt: '2026-04-19T00:00:00Z',
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('DripCampaigns admin page', () => {
  it('shows the empty state when no campaigns exist', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: { campaigns: [] } });
    render(<DripCampaigns />);
    await waitFor(() => {
      expect(screen.getByText(/No drip campaigns yet/i)).toBeInTheDocument();
    });
  });

  it('renders the campaign table when data loads', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: { campaigns: [sampleCampaign] } });
    render(<DripCampaigns />);
    await waitFor(() => {
      expect(screen.getByText('Brand step recovery')).toBeInTheDocument();
    });
    expect(screen.getByText('Emma is waiting')).toBeInTheDocument();
    expect(screen.getByText('brand_skipped')).toBeInTheDocument();
    expect(screen.getByText(/every 7 days/)).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('shows PAUSED badge when killSwitch=true', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: { campaigns: [{ ...sampleCampaign, killSwitch: true }] },
    });
    render(<DripCampaigns />);
    await waitFor(() => {
      expect(screen.getByText('PAUSED')).toBeInTheDocument();
    });
  });

  it('opens the create dialog and POSTs with correctly-shaped body', async () => {
    mockedAxios.get.mockResolvedValue({ data: { campaigns: [] } });
    mockedAxios.post.mockResolvedValueOnce({ data: { campaign: sampleCampaign } });

    render(<DripCampaigns />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /New Campaign/i })).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole('button', { name: /New Campaign/i }));
    // Dialog opens — find the heading (role=heading) rather than matching the
    // button text "New Campaign", which is ambiguous.
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: /New Campaign/i }),
      ).toBeInTheDocument();
    });

    const nameInput = screen.getByLabelText(/Campaign name/i);
    const subjectInput = screen.getByLabelText(/Email subject line/i);
    fireEvent.change(nameInput, { target: { value: 'Test drip' } });
    fireEvent.change(subjectInput, { target: { value: 'Hi there' } });

    await userEvent.click(screen.getByRole('button', { name: /Create/i }));

    await waitFor(() => {
      expect(mockedAxios.post).toHaveBeenCalled();
    });
    const [, body] = mockedAxios.post.mock.calls[0] as any;
    expect(body.name).toBe('Test drip');
    expect(body.subjectLine).toBe('Hi there');
    expect(body.segmentQuery.stage).toBe('brand_skipped');
    expect(body.cadenceUnit).toBe('days');
  });

  it('calls PATCH with inverted killSwitch when the pause icon is clicked', async () => {
    mockedAxios.get.mockResolvedValue({ data: { campaigns: [sampleCampaign] } });
    mockedAxios.patch.mockResolvedValueOnce({
      data: { campaign: { ...sampleCampaign, killSwitch: true } },
    });

    render(<DripCampaigns />);
    await waitFor(() => {
      expect(screen.getByText('Brand step recovery')).toBeInTheDocument();
    });

    const pauseBtn = screen.getByLabelText(/Engage kill switch/i);
    await userEvent.click(pauseBtn);

    await waitFor(() => {
      expect(mockedAxios.patch).toHaveBeenCalledWith(
        'http://localhost:3001/api/admin/drip-campaigns/cmp-1',
        { killSwitch: true },
        expect.objectContaining({ headers: { Authorization: 'Bearer mock-token' } }),
      );
    });
  });

  it('POSTs to /preview when the preview icon is clicked and shows rendered HTML', async () => {
    mockedAxios.get.mockResolvedValue({ data: { campaigns: [sampleCampaign] } });
    mockedAxios.post.mockResolvedValueOnce({
      data: { renderedHtml: '<p>Hi Alex.</p>', mergeFieldsUsed: ['firstName'] },
    });

    render(<DripCampaigns />);
    await waitFor(() => {
      expect(screen.getByText('Brand step recovery')).toBeInTheDocument();
    });

    await userEvent.click(screen.getByLabelText(/Preview rendered email/i));

    await waitFor(() => {
      expect(screen.getByText(/Email preview/i)).toBeInTheDocument();
    });
    expect(mockedAxios.post).toHaveBeenCalledWith(
      'http://localhost:3001/api/admin/drip-campaigns/cmp-1/preview',
      {},
      expect.any(Object),
    );
  });

  it('surfaces API error messages in an alert', async () => {
    mockedAxios.get.mockRejectedValueOnce({
      response: { data: { message: 'Dynamo is on fire' } },
    });
    render(<DripCampaigns />);
    await waitFor(() => {
      expect(screen.getByText(/Dynamo is on fire/i)).toBeInTheDocument();
    });
  });
});
