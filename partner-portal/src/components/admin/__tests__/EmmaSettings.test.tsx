import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import EmmaSettings from '../EmmaSettings';
import axios from 'axios';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

jest.mock('../../../contexts/AuthContext', () => ({
  useAuth: () => ({ token: 'fake-token' }),
}));

jest.mock('../../../config', () => ({
  buildApiUrl: (path: string) => `http://localhost:3000${path}`,
}));

const SAVED_SYSTEM_CONTEXT = 'Custom Emma system context saved by admin.';

describe('EmmaSettings component', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('loading state', () => {
    it('shows CircularProgress while loading', () => {
      mockedAxios.get.mockReturnValueOnce(new Promise(() => {})); // never resolves

      render(<EmmaSettings />);

      expect(screen.getByRole('progressbar')).toBeInTheDocument();
    });

    it('hides CircularProgress after data loads', async () => {
      mockedAxios.get.mockResolvedValueOnce({ data: { settingValue: SAVED_SYSTEM_CONTEXT } });

      render(<EmmaSettings />);

      await waitFor(() => {
        expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
      });
    });
  });

  describe('data loading', () => {
    it('populates textarea with saved setting value', async () => {
      mockedAxios.get.mockResolvedValueOnce({ data: { settingValue: SAVED_SYSTEM_CONTEXT } });

      render(<EmmaSettings />);

      await waitFor(() => {
        expect(screen.getByDisplayValue(SAVED_SYSTEM_CONTEXT)).toBeInTheDocument();
      });
    });

    it('falls back to default system context when API returns no settingValue', async () => {
      mockedAxios.get.mockResolvedValueOnce({ data: {} });

      render(<EmmaSettings />);

      await waitFor(() => {
        expect(screen.getByDisplayValue(/You are Emma Chat/i)).toBeInTheDocument();
      });
    });

    it('uses default context on API error', async () => {
      mockedAxios.get.mockRejectedValueOnce(new Error('Network error'));

      render(<EmmaSettings />);

      await waitFor(() => {
        expect(screen.getByDisplayValue(/You are Emma Chat/i)).toBeInTheDocument();
      });
    });
  });

  describe('save flow', () => {
    it('posts updated context on Save Changes click', async () => {
      mockedAxios.get.mockResolvedValueOnce({ data: { settingValue: SAVED_SYSTEM_CONTEXT } });
      mockedAxios.post.mockResolvedValueOnce({});

      render(<EmmaSettings />);
      await waitFor(() => expect(screen.queryByRole('progressbar')).not.toBeInTheDocument());

      fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

      await waitFor(() => {
        expect(mockedAxios.post).toHaveBeenCalledWith(
          'http://localhost:3000/api/settings',
          expect.objectContaining({
            settingName: 'emma_system_context',
            settingValue: SAVED_SYSTEM_CONTEXT,
          }),
          expect.any(Object)
        );
      });
    });

    it('shows success alert after saving', async () => {
      mockedAxios.get.mockResolvedValueOnce({ data: { settingValue: SAVED_SYSTEM_CONTEXT } });
      mockedAxios.post.mockResolvedValueOnce({});

      render(<EmmaSettings />);
      await waitFor(() => expect(screen.queryByRole('progressbar')).not.toBeInTheDocument());

      fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

      await waitFor(() => {
        expect(screen.getByText(/saved successfully/i)).toBeInTheDocument();
      });
    });

    it('shows error alert when save fails', async () => {
      mockedAxios.get.mockResolvedValueOnce({ data: { settingValue: SAVED_SYSTEM_CONTEXT } });
      mockedAxios.post.mockRejectedValueOnce({
        response: { data: { error: 'Unauthorized' } },
      });

      render(<EmmaSettings />);
      await waitFor(() => expect(screen.queryByRole('progressbar')).not.toBeInTheDocument());

      fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

      await waitFor(() => {
        expect(screen.getByText('Unauthorized')).toBeInTheDocument();
      });
    });

    it('shows generic error when save fails without response detail', async () => {
      mockedAxios.get.mockResolvedValueOnce({ data: { settingValue: SAVED_SYSTEM_CONTEXT } });
      mockedAxios.post.mockRejectedValueOnce(new Error('Network error'));

      render(<EmmaSettings />);
      await waitFor(() => expect(screen.queryByRole('progressbar')).not.toBeInTheDocument());

      fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

      await waitFor(() => {
        expect(screen.getByText(/failed to save/i)).toBeInTheDocument();
      });
    });
  });

  describe('reset to default', () => {
    it('resets textarea to default system context on Reset click', async () => {
      mockedAxios.get.mockResolvedValueOnce({ data: { settingValue: 'Custom value' } });

      render(<EmmaSettings />);
      await waitFor(() => expect(screen.getByDisplayValue('Custom value')).toBeInTheDocument());

      fireEvent.click(screen.getByRole('button', { name: /reset to default/i }));

      expect(screen.getByDisplayValue(/You are Emma Chat/i)).toBeInTheDocument();
    });
  });

  describe('textarea interaction', () => {
    it('updates textarea value on user input', async () => {
      mockedAxios.get.mockResolvedValueOnce({ data: { settingValue: 'Original' } });

      render(<EmmaSettings />);
      await waitFor(() => expect(screen.getByDisplayValue('Original')).toBeInTheDocument());

      const textarea = screen.getByDisplayValue('Original');
      fireEvent.change(textarea, { target: { value: 'Updated content' } });

      expect(screen.getByDisplayValue('Updated content')).toBeInTheDocument();
    });
  });
});
