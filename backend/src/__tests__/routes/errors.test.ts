/**
 * Tests for POST /api/errors/report — frontend error ingestion endpoint.
 */

// Mock heavy dependencies before any imports (required to load app.ts)
const mockDynamo = () => ({
  put: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
  get: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
  query: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ Items: [] }) }),
  scan: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ Items: [] }) }),
  update: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
  delete: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
  batchWrite: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
});
const mockS3 = () => ({
  upload: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
  getObject: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
  putObject: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
  deleteObject: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
  getSignedUrl: jest.fn().mockReturnValue('https://mock-url'),
  headObject: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
  listObjectsV2: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ Contents: [] }) }),
});
const awsMock = {
  config: { update: jest.fn() },
  DynamoDB: { DocumentClient: jest.fn(mockDynamo) },
  S3: jest.fn(mockS3),
  EC2: jest.fn(() => ({ describeInstances: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }) })),
  SSM: jest.fn(() => ({ sendCommand: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }) })),
  IAM: jest.fn(() => ({ getInstanceProfile: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }) })),
  SecretsManager: jest.fn(() => ({ getSecretValue: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ SecretString: '{}' }) }) })),
  SES: jest.fn(() => ({})),
};
jest.mock('aws-sdk', () => ({ __esModule: true, default: awsMock, ...awsMock }));

jest.mock('../../utils/errorReporter', () => ({
  reportUIError: jest.fn().mockResolvedValue(undefined),
  __clearDedupCacheForTests: jest.fn(),
}));

import request from 'supertest';
import app from '../../app';
import { reportUIError } from '../../utils/errorReporter';

const mockReportUIError = reportUIError as jest.MockedFunction<typeof reportUIError>;

describe('POST /api/errors/report', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 400 when operation is missing', async () => {
    const res = await request(app)
      .post('/api/errors/report')
      .send({ errorMessage: 'something broke' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when errorMessage is missing', async () => {
    const res = await request(app)
      .post('/api/errors/report')
      .send({ operation: 'react-error-boundary' });
    expect(res.status).toBe(400);
  });

  it('returns 200 and calls reportUIError with frontend prefix', async () => {
    const res = await request(app)
      .post('/api/errors/report')
      .send({
        operation: 'react-error-boundary',
        errorMessage: 'Cannot read properties of undefined',
        context: { componentStack: 'at Component (App.tsx:42)', errorName: 'TypeError' },
      });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockReportUIError).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'frontend:react-error-boundary',
        errorMessage: 'Cannot read properties of undefined',
        context: expect.objectContaining({ Source: 'frontend' }),
      })
    );
  });

  it('truncates long errorMessage to 1000 chars', async () => {
    const longMessage = 'x'.repeat(2000);
    const res = await request(app)
      .post('/api/errors/report')
      .send({ operation: 'window-error', errorMessage: longMessage });
    expect(res.status).toBe(200);
    expect(mockReportUIError).toHaveBeenCalledWith(
      expect.objectContaining({ errorMessage: 'x'.repeat(1000) })
    );
  });

  it('returns 200 even when reportUIError throws (fire-and-forget)', async () => {
    mockReportUIError.mockRejectedValueOnce(new Error('Notion down'));
    const res = await request(app)
      .post('/api/errors/report')
      .send({ operation: 'unhandled-rejection', errorMessage: 'fetch failed' });
    expect(res.status).toBe(200);
  });

  it('ignores non-object context values', async () => {
    const res = await request(app)
      .post('/api/errors/report')
      .send({ operation: 'op', errorMessage: 'err', context: 'invalid string' });
    expect(res.status).toBe(200);
    expect(mockReportUIError).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({ Source: 'frontend' }),
      })
    );
  });
});
