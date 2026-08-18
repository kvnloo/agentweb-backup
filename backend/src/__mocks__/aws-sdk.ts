// Shared manual mock for aws-sdk
// This is automatically used by Jest when a test calls jest.mock('aws-sdk')
// without providing a factory function.

const mockPromise = jest.fn().mockResolvedValue({});

const mockDocumentClient = jest.fn(() => ({
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
