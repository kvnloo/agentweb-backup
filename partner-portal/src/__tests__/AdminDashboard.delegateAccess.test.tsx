import '@testing-library/jest-dom';

// Guards the fix for ENG-279: Access Portal must not lose the delegated URL when
// the browser blocks the popup. The fix opens a placeholder tab synchronously
// (inside the click handler, before the async request) and navigates it once the
// URL resolves. If the popup is still blocked, the URL is surfaced to the admin.
//
// This mirrors the `handleAccessCustomerPortal` logic in AdminDashboard.tsx,
// following the existing convention of testing extracted AdminDashboard logic.

interface HandlerDeps {
  windowOpen: (url: string, target: string) => Window | null;
  post: () => Promise<{ status: number; data: { customerPortalUrl: string } }>;
  onSuccess: (msg: string) => void;
  onExposeUrl: (url: string) => void;
  onError: (msg: string) => void;
}

async function handleAccessCustomerPortal(deps: HandlerDeps) {
  const placeholderTab = deps.windowOpen('', '_blank');
  try {
    const response = await deps.post();
    if (response.status === 200) {
      const { customerPortalUrl } = response.data;
      if (placeholderTab && !placeholderTab.closed) {
        placeholderTab.location.href = customerPortalUrl;
        deps.onSuccess('Delegate access created successfully!');
      } else {
        deps.onExposeUrl(customerPortalUrl);
      }
    }
  } catch (error: any) {
    if (placeholderTab && !placeholderTab.closed) {
      placeholderTab.close();
    }
    deps.onError('Failed to create delegate access');
  }
}

const PORTAL_URL = 'https://app.agentweb.pro/delegate?token=abc123';

describe('AdminDashboard - Access Portal delegate access (ENG-279)', () => {
  it('opens the placeholder tab synchronously BEFORE awaiting the request', async () => {
    const openOrder: string[] = [];
    const fakeTab = {
      closed: false,
      location: { href: '' },
      close: jest.fn(),
    } as unknown as Window;

    const deps: HandlerDeps = {
      windowOpen: jest.fn(() => {
        openOrder.push('open');
        return fakeTab;
      }),
      post: jest.fn(async () => {
        openOrder.push('post');
        return { status: 200, data: { customerPortalUrl: PORTAL_URL } };
      }),
      onSuccess: jest.fn(),
      onExposeUrl: jest.fn(),
      onError: jest.fn(),
    };

    await handleAccessCustomerPortal(deps);

    // window.open must fire before the network request so the browser keeps the
    // user-gesture context and does not block the popup.
    expect(openOrder).toEqual(['open', 'post']);
    expect(deps.windowOpen).toHaveBeenCalledWith('', '_blank');
    expect((fakeTab as any).location.href).toBe(PORTAL_URL);
    expect(deps.onSuccess).toHaveBeenCalledWith('Delegate access created successfully!');
    expect(deps.onExposeUrl).not.toHaveBeenCalled();
  });

  it('exposes the delegated URL when the popup is blocked (window.open returns null)', async () => {
    const deps: HandlerDeps = {
      windowOpen: jest.fn(() => null), // simulate popup blocker
      post: jest.fn(async () => ({ status: 200, data: { customerPortalUrl: PORTAL_URL } })),
      onSuccess: jest.fn(),
      onExposeUrl: jest.fn(),
      onError: jest.fn(),
    };

    await handleAccessCustomerPortal(deps);

    // The admin must be able to recover the URL even though no tab opened.
    expect(deps.onExposeUrl).toHaveBeenCalledWith(PORTAL_URL);
    expect(deps.onSuccess).not.toHaveBeenCalled();
    expect(deps.onError).not.toHaveBeenCalled();
  });

  it('exposes the delegated URL when the placeholder tab was closed before the URL resolved', async () => {
    const closedTab = {
      closed: true,
      location: { href: '' },
      close: jest.fn(),
    } as unknown as Window;

    const deps: HandlerDeps = {
      windowOpen: jest.fn(() => closedTab),
      post: jest.fn(async () => ({ status: 200, data: { customerPortalUrl: PORTAL_URL } })),
      onSuccess: jest.fn(),
      onExposeUrl: jest.fn(),
      onError: jest.fn(),
    };

    await handleAccessCustomerPortal(deps);

    expect(deps.onExposeUrl).toHaveBeenCalledWith(PORTAL_URL);
    expect((closedTab as any).location.href).toBe('');
    expect(deps.onSuccess).not.toHaveBeenCalled();
  });

  it('closes the placeholder tab and reports an error when the request fails', async () => {
    const fakeTab = {
      closed: false,
      location: { href: '' },
      close: jest.fn(),
    } as unknown as Window;

    const deps: HandlerDeps = {
      windowOpen: jest.fn(() => fakeTab),
      post: jest.fn(async () => {
        throw new Error('network down');
      }),
      onSuccess: jest.fn(),
      onExposeUrl: jest.fn(),
      onError: jest.fn(),
    };

    await handleAccessCustomerPortal(deps);

    // No blank tab should be left behind, and the error must surface.
    expect((fakeTab as any).close).toHaveBeenCalled();
    expect(deps.onError).toHaveBeenCalledWith('Failed to create delegate access');
    expect(deps.onSuccess).not.toHaveBeenCalled();
    expect(deps.onExposeUrl).not.toHaveBeenCalled();
  });
});
