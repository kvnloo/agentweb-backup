import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation, MemoryRouter, Route, Routes } from 'react-router-dom';
import axios from 'axios';

import { AuthProvider } from '../../contexts/AuthContext';
import Login from '../Login';

jest.mock('../../config', () => ({
  buildApiUrl: (endpoint: string) => `http://localhost:3001${endpoint}`,
}));

jest.mock('../../components/GoogleSignInButton', () => ({
  __esModule: true,
  default: () => <button type="button">Continue with Google</button>,
}));

jest.mock('axios', () => ({
  __esModule: true,
  default: {
    get: jest.fn(),
    post: jest.fn(),
    interceptors: {
      request: { use: jest.fn(), eject: jest.fn() },
      response: { use: jest.fn(() => 1), eject: jest.fn() },
    },
  },
}));

const mockedAxios = axios as jest.Mocked<typeof axios>;

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

function renderAdminLogin() {
  return render(
    <AuthProvider>
      <MemoryRouter
        initialEntries={[
          {
            pathname: '/login',
            state: { from: { pathname: '/admin', search: '?tab=costs' } },
          },
        ]}
      >
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="*" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
}

async function fillCredentials() {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/email address/i), 'admin@example.com');
  await user.type(screen.getByLabelText(/password/i), 'valid-test-password');
  return user;
}

function fillCredentialsAtTheBrowserBoundary() {
  const email = screen.getByLabelText(/email address/i) as HTMLInputElement;
  const password = screen.getByLabelText(/password/i) as HTMLInputElement;

  // Browser automation can update the live form controls without committing a
  // React change event. The form contract must submit those visible values.
  email.value = 'admin@example.com';
  password.value = 'valid-test-password';

  return { email, password };
}

async function expectAdminLogin() {
  await waitFor(() => {
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    expect(mockedAxios.post).toHaveBeenCalledWith(
      'http://localhost:3001/api/auth/login',
      {
        email: 'admin@example.com',
        password: 'valid-test-password',
      },
    );
  });
  expect((await screen.findByTestId('location')).textContent).toBe(
    '/admin?tab=costs',
  );
}

describe('ENG-631 — deterministic admin-login keyboard contract', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    mockedAxios.post.mockResolvedValue({
      data: {
        token: 'test-admin-token',
        user: {
          userId: 'admin-1',
          email: 'admin@example.com',
          roles: ['partner'],
          isAdmin: true,
          isOAuthUser: false,
          createdAt: '2026-07-28T00:00:00Z',
        },
      },
    });
  });

  it('submits and returns to the requested admin surface from password Enter', async () => {
    renderAdminLogin();
    const { password } = fillCredentialsAtTheBrowserBoundary();

    fireEvent.keyDown(password, { key: 'Enter', code: 'Enter' });

    await expectAdminLogin();
  });

  it('submits and returns to the requested admin surface from button Enter', async () => {
    renderAdminLogin();
    fillCredentialsAtTheBrowserBoundary();
    const submit = screen.getByRole('button', { name: /sign in with email/i });

    act(() => submit.focus());
    expect(document.activeElement).toBe(submit);
    fireEvent.keyDown(submit, { key: 'Enter', code: 'Enter' });

    await expectAdminLogin();
  });

  it('submits and returns to the requested admin surface from button Space', async () => {
    renderAdminLogin();
    fillCredentialsAtTheBrowserBoundary();
    const submit = screen.getByRole('button', { name: /sign in with email/i });

    act(() => submit.focus());
    expect(document.activeElement).toBe(submit);
    fireEvent.keyDown(submit, { key: ' ', code: 'Space' });

    await expectAdminLogin();
  });

  it('keeps pointer activation as the passing control', async () => {
    renderAdminLogin();
    const user = await fillCredentials();

    await user.click(screen.getByRole('button', { name: /sign in with email/i }));

    await waitFor(() => {
      expect(mockedAxios.post).toHaveBeenCalledWith(
        'http://localhost:3001/api/auth/login',
        {
          email: 'admin@example.com',
          password: 'valid-test-password',
        },
      );
    });
  });

  it('renders an invalid-credentials response instead of remaining inert', async () => {
    mockedAxios.post.mockRejectedValueOnce({
      response: { data: { message: 'Invalid credentials' } },
      message: 'Request failed with status 401',
    });
    renderAdminLogin();
    const user = await fillCredentials();

    await user.click(screen.getByRole('button', { name: /sign in with email/i }));

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Invalid credentials',
    );
    expect(screen.queryByTestId('location')).toBeNull();
  });
});
