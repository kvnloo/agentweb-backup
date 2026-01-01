// Unit tests for waitlistDb.updateDetails
const mockDocumentClientMethods = {
  put: jest.fn(),
  get: jest.fn(),
  scan: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
};

jest.mock('aws-sdk', () => {
  return {
    config: {
      update: jest.fn(),
    },
    DynamoDB: {
      DocumentClient: jest.fn(() => mockDocumentClientMethods),
    },
  };
});

import { waitlistDb } from '../services/waitlistDb';

describe('waitlistDb.updateDetails', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.keys(mockDocumentClientMethods).forEach(method => {
      (mockDocumentClientMethods as any)[method].mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });
    });
  });

  it('should return existing entry when no writable fields are provided', async () => {
    const email = 'Test@Example.com';
    const existingEntry = { email: 'test@example.com', fullName: 'Existing' };

    mockDocumentClientMethods.get.mockReturnValue({
      promise: jest.fn().mockResolvedValue({ Item: existingEntry }),
    });

    const result = await waitlistDb.updateDetails(email, {
      email: 'ignore@example.com',
      joinedAt: new Date().toISOString(),
    });

    expect(mockDocumentClientMethods.get).toHaveBeenCalledWith(
      expect.objectContaining({
        Key: { email: 'test@example.com' },
      })
    );
    expect(result).toEqual(existingEntry);
  });

  it('should update provided fields and ignore non-writable keys', async () => {
    const email = 'Test@Example.com';
    const updatedEntry = {
      email: 'test@example.com',
      fullName: 'New Name',
      supportNote: 'Updated note',
    };

    mockDocumentClientMethods.update.mockReturnValue({
      promise: jest.fn().mockResolvedValue({ Attributes: updatedEntry }),
    });

    const result = await waitlistDb.updateDetails(email, {
      email: 'ignored@example.com',
      joinedAt: '2024-01-01T00:00:00.000Z',
      fullName: 'New Name',
      supportNote: 'Updated note',
      phoneNumber: undefined,
    });

    expect(mockDocumentClientMethods.update).toHaveBeenCalledWith(
      expect.objectContaining({
        Key: { email: 'test@example.com' },
        UpdateExpression: 'SET #fullName = :fullName, #supportNote = :supportNote',
        ExpressionAttributeNames: {
          '#fullName': 'fullName',
          '#supportNote': 'supportNote',
        },
        ExpressionAttributeValues: {
          ':fullName': 'New Name',
          ':supportNote': 'Updated note',
        },
        ReturnValues: 'ALL_NEW',
      })
    );
    expect(result).toEqual(updatedEntry);
  });
});
