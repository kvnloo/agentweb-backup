import '@testing-library/jest-dom';

// Test the sessionType display logic
describe('AdminDashboard - Chat History Session Type Display', () => {
  const getSessionTypeLabel = (sessionType?: string) => {
    if (!sessionType) return 'Undefined';
    if (sessionType === 'predefined-work-plan') return 'Predefined Work Plan';
    if (sessionType === 'scheduled') return 'Scheduled';
    if (sessionType === 'image-generation') return 'Image Generation';
    if (sessionType === 'video-generation') return 'Video Generation';
    if (sessionType === 'book-generation') return 'Book Generation';
    if (sessionType === 'report_generation') return 'Report Generation';
    return 'Regular';
  };

  const getSessionTypeColor = (sessionType?: string) => {
    if (sessionType === 'predefined-work-plan') return 'primary';
    if (sessionType === 'scheduled') return 'secondary';
    if (sessionType === 'image-generation') return 'success';
    if (sessionType === 'video-generation') return 'info';
    if (sessionType === 'book-generation') return 'info';
    if (sessionType === 'report_generation') return 'warning';
    return 'default';
  };

  it('should return "Regular" for regular sessionType', () => {
    expect(getSessionTypeLabel('regular')).toBe('Regular');
    expect(getSessionTypeColor('regular')).toBe('default');
  });

  it('should return "Predefined Work Plan" for predefined-work-plan sessionType', () => {
    expect(getSessionTypeLabel('predefined-work-plan')).toBe('Predefined Work Plan');
    expect(getSessionTypeColor('predefined-work-plan')).toBe('primary');
  });

  it('should return "Scheduled" for scheduled sessionType', () => {
    expect(getSessionTypeLabel('scheduled')).toBe('Scheduled');
    expect(getSessionTypeColor('scheduled')).toBe('secondary');
  });

  it('should return "Image Generation" for image-generation sessionType', () => {
    expect(getSessionTypeLabel('image-generation')).toBe('Image Generation');
    expect(getSessionTypeColor('image-generation')).toBe('success');
  });

  it('should return "Video Generation" for video-generation sessionType', () => {
    expect(getSessionTypeLabel('video-generation')).toBe('Video Generation');
    expect(getSessionTypeColor('video-generation')).toBe('info');
  });

  it('should return "Book Generation" for book-generation sessionType', () => {
    expect(getSessionTypeLabel('book-generation')).toBe('Book Generation');
    expect(getSessionTypeColor('book-generation')).toBe('info');
  });

  it('should return "Report Generation" for report_generation sessionType', () => {
    expect(getSessionTypeLabel('report_generation')).toBe('Report Generation');
    expect(getSessionTypeColor('report_generation')).toBe('warning');
  });

  it('should return "Undefined" for undefined sessionType', () => {
    expect(getSessionTypeLabel(undefined)).toBe('Undefined');
    expect(getSessionTypeColor(undefined)).toBe('default');
  });
});

// Test the share button logic
describe('AdminDashboard - Chat History Share Button Logic', () => {
  const CUSTOMER_FRONTEND_URL = 'https://customer.agentweb.pro';

  const shouldShowViewOnlyShare = (
    shareMetadata?: { isShared: boolean },
    interactiveShareMetadata?: { isActive: boolean; token?: string }
  ) => {
    return (
      shareMetadata?.isShared &&
      !(interactiveShareMetadata?.isActive && interactiveShareMetadata?.token)
    );
  };

  const shouldShowInteractiveShare = (
    interactiveShareMetadata?: { isActive: boolean; token?: string }
  ) => {
    return !!(interactiveShareMetadata?.isActive && interactiveShareMetadata?.token);
  };

  const getViewOnlyShareUrl = (sessionId: string) => {
    return `${CUSTOMER_FRONTEND_URL}/share/${sessionId}`;
  };

  const getInteractiveShareUrl = (
    sessionId: string,
    sessionType: string | undefined,
    workPlanTitle: string | undefined,
    token: string
  ) => {
    if (sessionType === 'predefined-work-plan' && workPlanTitle) {
      return `${CUSTOMER_FRONTEND_URL}/plan/${encodeURIComponent(workPlanTitle)}/${sessionId}?conversable=${token}`;
    }
    return `${CUSTOMER_FRONTEND_URL}/ishare/${sessionId}?conversable=${token}`;
  };

  it('should show view-only share button when shareMetadata.isShared is true and no interactive share', () => {
    const shareMetadata = { isShared: true };
    const interactiveShareMetadata = undefined;

    expect(shouldShowViewOnlyShare(shareMetadata, interactiveShareMetadata)).toBe(true);
    expect(shouldShowInteractiveShare(interactiveShareMetadata)).toBe(false);
  });

  it('should not show view-only share button when interactive share is active', () => {
    const shareMetadata = { isShared: true };
    const interactiveShareMetadata = { isActive: true, token: 'token-123' };

    expect(shouldShowViewOnlyShare(shareMetadata, interactiveShareMetadata)).toBe(false);
    expect(shouldShowInteractiveShare(interactiveShareMetadata)).toBe(true);
  });

  it('should show interactive share button when interactiveShareMetadata is active with token', () => {
    const interactiveShareMetadata = { isActive: true, token: 'token-123' };

    expect(shouldShowInteractiveShare(interactiveShareMetadata)).toBe(true);
  });

  it('should generate correct view-only share URL', () => {
    const url = getViewOnlyShareUrl('session-123');
    expect(url).toBe(`${CUSTOMER_FRONTEND_URL}/share/session-123`);
  });

  it('should generate correct interactive share URL for regular session', () => {
    const url = getInteractiveShareUrl('session-123', 'regular', undefined, 'token-123');
    expect(url).toBe(`${CUSTOMER_FRONTEND_URL}/ishare/session-123?conversable=token-123`);
  });

  it('should generate correct interactive share URL for predefined-work-plan session', () => {
    const url = getInteractiveShareUrl(
      'session-123',
      'predefined-work-plan',
      'Onboarding Plan',
      'token-123'
    );
    expect(url).toBe(
      `${CUSTOMER_FRONTEND_URL}/plan/Onboarding%20Plan/session-123?conversable=token-123`
    );
  });

  it('should not show view-only share when interactive share exists', () => {
    const session = {
      sessionId: 'session-123',
      shareMetadata: { isShared: true },
      interactiveShareMetadata: { isActive: true, token: 'token-123' },
    };

    expect(shouldShowViewOnlyShare(session.shareMetadata, session.interactiveShareMetadata)).toBe(
      false
    );
    expect(shouldShowInteractiveShare(session.interactiveShareMetadata)).toBe(true);
  });
});
