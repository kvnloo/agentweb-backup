/**
 * ENG-1756 regression tests: GET /api/stripe/session/:sessionId must be
 * read-only. It used to write companyName/useCaseCategories/
 * stripe_customer_id onto the user record (and upsert a waitlist entry)
 * for anyone who supplied a valid Stripe session id — no authentication
 * required. Those writes moved to the signature-verified
 * `checkout.session.completed` webhook handler.
 */
import express from 'express';
import request from 'supertest';

const mockCheckoutSessionsRetrieve = jest.fn();

jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => ({
    checkout: {
      sessions: {
        retrieve: mockCheckoutSessionsRetrieve,
      },
    },
  }));
});

const mockGetUserByEmail = jest.fn();
const mockUpdateUser = jest.fn();

jest.mock('../services/db', () => ({
  userDb: {
    getUserByEmail: mockGetUserByEmail,
    updateUser: mockUpdateUser,
    getUserById: jest.fn(),
    getAllUsers: jest.fn(),
    scanWithFilter: jest.fn(),
  },
}));

const mockWaitlistGetByEmail = jest.fn();
const mockWaitlistUpdateDetails = jest.fn();
const mockWaitlistAdd = jest.fn();

jest.mock('../services/waitlistDb', () => ({
  waitlistDb: {
    getByEmail: mockWaitlistGetByEmail,
    updateDetails: mockWaitlistUpdateDetails,
    add: mockWaitlistAdd,
  },
}));

process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const stripeRoutes = require('../routes/stripe').default;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/stripe', stripeRoutes);
  return app;
}

describe('GET /api/stripe/session/:sessionId (ENG-1756, read-only)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns email + existingUser without requiring auth, and writes nothing', async () => {
    mockCheckoutSessionsRetrieve.mockResolvedValue({
      status: 'complete',
      payment_status: 'paid',
      customer_details: { email: 'Buyer@Example.com' },
      custom_fields: [
        { key: 'companyname', text: { value: 'Acme Inc' } },
      ],
    });
    mockGetUserByEmail.mockResolvedValue({ userId: 'user-1', email: 'buyer@example.com' });

    const app = buildApp();
    const res = await request(app).get('/api/stripe/session/cs_test_abc123');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      email: 'buyer@example.com',
      existingUser: true,
      payment_status: 'paid',
    });

    // The old route wrote companyName/useCaseCategories/stripe_customer_id
    // straight from an unauthenticated session lookup. Prove it no longer does.
    expect(mockUpdateUser).not.toHaveBeenCalled();
    expect(mockWaitlistAdd).not.toHaveBeenCalled();
    expect(mockWaitlistUpdateDetails).not.toHaveBeenCalled();
  });

  it('reports existingUser: false and still writes nothing for a new email', async () => {
    mockCheckoutSessionsRetrieve.mockResolvedValue({
      status: 'complete',
      payment_status: 'paid',
      customer_details: { email: 'new@example.com' },
    });
    mockGetUserByEmail.mockResolvedValue(null);

    const app = buildApp();
    const res = await request(app).get('/api/stripe/session/cs_test_new456');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      email: 'new@example.com',
      existingUser: false,
      payment_status: 'paid',
    });

    expect(mockUpdateUser).not.toHaveBeenCalled();
    expect(mockWaitlistAdd).not.toHaveBeenCalled();
    expect(mockWaitlistUpdateDetails).not.toHaveBeenCalled();
    expect(mockWaitlistGetByEmail).not.toHaveBeenCalled();
  });

  it('rejects a malformed session id before calling Stripe', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/stripe/session/not-a-real-id');

    expect(res.status).toBe(400);
    expect(mockCheckoutSessionsRetrieve).not.toHaveBeenCalled();
  });

  it('404s when the session has no resolvable email, writes nothing', async () => {
    mockCheckoutSessionsRetrieve.mockResolvedValue({
      status: 'complete',
      payment_status: 'unpaid',
    });

    const app = buildApp();
    const res = await request(app).get('/api/stripe/session/cs_test_noemail');

    expect(res.status).toBe(404);
    expect(mockGetUserByEmail).not.toHaveBeenCalled();
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });
});
