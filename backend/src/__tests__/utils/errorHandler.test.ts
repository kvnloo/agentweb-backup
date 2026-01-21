import { handleDynamoError } from '../../utils/errorHandler';

describe('errorHandler utils', () => {
  describe('handleDynamoError', () => {
    beforeEach(() => {
      jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('should throw "Item already exists" for ConditionalCheckFailedException', () => {
      const error = { code: 'ConditionalCheckFailedException' };
      expect(() => handleDynamoError(error)).toThrow('Item already exists');
    });

    it('should throw "Table not found" for ResourceNotFoundException', () => {
      const error = { code: 'ResourceNotFoundException' };
      expect(() => handleDynamoError(error)).toThrow('Table not found');
    });

    it('should throw "Invalid data format" for ValidationException', () => {
      const error = { code: 'ValidationException' };
      expect(() => handleDynamoError(error)).toThrow('Invalid data format');
    });

    it('should throw "Database operation failed" for unknown errors', () => {
      const error = { code: 'UnknownError' };
      expect(() => handleDynamoError(error)).toThrow('Database operation failed');
    });

    it('should throw "Database operation failed" for errors without code', () => {
      const error = { message: 'Some error' };
      expect(() => handleDynamoError(error)).toThrow('Database operation failed');
    });

    it('should log the error to console', () => {
      const error = { code: 'SomeError' };
      try {
        handleDynamoError(error);
      } catch (e) {
        // Expected
      }
      expect(console.error).toHaveBeenCalledWith('DynamoDB Error:', error);
    });
  });
});
