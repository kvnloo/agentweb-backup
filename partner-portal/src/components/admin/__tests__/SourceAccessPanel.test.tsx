import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import axios from 'axios';
import SourceAccessPanel from '../SourceAccessPanel';
import { useAuth } from '../../../contexts/AuthContext';
jest.mock('axios');
jest.mock('../../../config', () => ({ buildApiUrl: (path: string) => path }));
jest.mock('../../../contexts/AuthContext', () => ({ useAuth: jest.fn() }));
const source = { id: 'clickup', provider: 'clickup', identity: null, scope: 'Organization' };
beforeEach(() => { jest.resetAllMocks(); (useAuth as jest.Mock).mockReturnValue({ token: 'token-a' }); });
test('shows identity, last check, hierarchy, and incomplete state after refresh', async () => {
  (axios.get as jest.Mock).mockResolvedValueOnce({ data: { sources: [source] } }).mockResolvedValueOnce({ data: {
    identity: 'connected@example.com', checkedAt: '2026-09-23T12:00:00Z', complete: false,
    items: [{ id: 's', name: 'Space', kind: 'space', parentId: null }, { id: 'd', name: 'Document', kind: 'doc', parentId: 'space:s' }],
  } });
  render(<SourceAccessPanel />);
  fireEvent.click(await screen.findByRole('button', { name: 'Refresh ClickUp access' }));
  expect(await screen.findByText(/connected@example.com/)).toBeInTheDocument();
  expect(screen.getByText(/Incomplete listing/)).toBeInTheDocument();
  expect(screen.getByTitle('/Space/Document')).toBeInTheDocument();
  expect(screen.getByText(/Last checked:/)).not.toHaveTextContent('Not checked');
});
test('non-admin has no sources or refresh controls', async () => {
  (axios.get as jest.Mock).mockRejectedValue({ response: { status: 403 } });
  render(<SourceAccessPanel />);
  expect(await screen.findByText('Organization admin access required.')).toBeInTheDocument();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});
test('token switch clears prior org inventory', async () => {
  (axios.get as jest.Mock).mockResolvedValueOnce({ data: { sources: [source] } });
  const { rerender } = render(<SourceAccessPanel />);
  await screen.findByRole('button');
  (useAuth as jest.Mock).mockReturnValue({ token: 'token-b' });
  (axios.get as jest.Mock).mockResolvedValueOnce({ data: { sources: [] } });
  rerender(<SourceAccessPanel />);
  await screen.findByText(/No ClickUp or Google Drive/);
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});
test('failed refresh clears the previous result', async () => {
  (axios.get as jest.Mock).mockResolvedValueOnce({ data: { sources: [source] } }).mockResolvedValueOnce({ data: {
    identity: 'someone@example.com', checkedAt: '2026-09-23T12:00:00Z', complete: true,
    items: [{ id: 'd', name: 'Old document', kind: 'doc', parentId: null }],
  } }).mockRejectedValueOnce(new Error('unavailable'));
  render(<SourceAccessPanel />);
  fireEvent.click(await screen.findByRole('button'));
  await screen.findByText('Old document');
  fireEvent.click(screen.getByRole('button'));
  await screen.findByText(/Unable to check/);
  expect(screen.queryByText('Old document')).not.toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole('button')).toBeEnabled());
});
test('malformed source entries fail closed without crashing', async () => {
  (axios.get as jest.Mock).mockResolvedValueOnce({ data: { sources: [null] } });
  render(<SourceAccessPanel />);
  expect(await screen.findByText(/Unable to load connected/)).toBeInTheDocument();
});
test('malformed inventory entries are treated as a failed check', async () => {
  (axios.get as jest.Mock).mockResolvedValueOnce({ data: { sources: [source] } }).mockResolvedValueOnce({ data: {
    identity: null, checkedAt: '2026-09-23T12:00:00Z', complete: true, items: [null],
  } });
  render(<SourceAccessPanel />);
  fireEvent.click(await screen.findByRole('button'));
  expect(await screen.findByText(/Unable to check source/)).toBeInTheDocument();
});
