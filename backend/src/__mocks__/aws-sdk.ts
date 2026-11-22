// Shared manual mock for aws-sdk
// This is automatically used by Jest when a test calls jest.mock('aws-sdk')
// without providing a factory function.

const mockPromise = jest.fn().mockResolvedValue({});

// ENG-2816: the real DocumentClient's `createSet`, minimal: an object shaped like its DynamoDBSet (`wrapperName`, `type`, `values`, and
// `toJSON` giving the values), and like the real one it refuses an empty list (a String Set cannot be empty). Plain functions, not
// jest.fn(), so a suite's resetAllMocks() cannot blank it. Without it, code that writes a schedule's `provenance` throws a TypeError
// in every suite that reaches createSchedule / updateSchedule through this mock.
const createSet = (list: unknown) => {
  const values = ([] as unknown[]).concat(list);
  if (values.length === 0 || (typeof values[0] !== 'string' && typeof values[0] !== 'number')) {
    throw Object.assign(new Error('Sets can contain string, number, or binary values'), { code: 'InvalidSetType' });
  }
  return { wrapperName: 'Set', type: typeof values[0] === 'number' ? 'Number' : 'String', values, toJSON: () => values };
};

const mockDocumentClient = jest.fn(() => ({
  createSet,
  get: jest.fn().mockReturnValue({ promise: mockPromise }),
  put: jest.fn().mockReturnValue({ promise: mockPromise }),
  update: jest.fn().mockReturnValue({ promise: mockPromise }),
  delete: jest.fn().mockReturnValue({ promise: mockPromise }),
  scan: jest.fn().mockReturnValue({ promise: mockPromise }),
  query: jest.fn().mockReturnValue({ promise: mockPromise }),
  transactWrite: jest.fn().mockReturnValue({ promise: mockPromise }),
  transactGet: jest.fn().mockReturnValue({ promise: mockPromise }),
  batchGet: jest.fn().mockReturnValue({ promise: mockPromise }),
  batchWrite: jest.fn().mockReturnValue({ promise: mockPromise }),
}));

const mockS3 = jest.fn(() => ({
  upload: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ Location: 'https://mock-s3-url.com/file', Key: 'mock-key' }) }),
  getObject: jest.fn().mockReturnValue({ promise: mockPromise }),
  putObject: jest.fn().mockReturnValue({ promise: mockPromise }),
  deleteObject: jest.fn().mockReturnValue({ promise: mockPromise }),
}));

const mockSecretsManager = jest.fn(() => ({
  getSecretValue: jest.fn().mockReturnValue({
    promise: jest.fn().mockResolvedValue({ SecretString: '{}' }),
  }),
}));

const awsSdk = {
  default: {
    S3: mockS3,
    DynamoDB: {
      DocumentClient: mockDocumentClient,
    },
    SecretsManager: mockSecretsManager,
    config: {
      update: jest.fn(),
    },
  },
  S3: mockS3,
  DynamoDB: {
    DocumentClient: mockDocumentClient,
  },
  SecretsManager: mockSecretsManager,
  config: {
    update: jest.fn(),
  },
};

module.exports = awsSdk;
