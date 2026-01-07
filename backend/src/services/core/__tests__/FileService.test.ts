
import { FileService } from '../FileService';
import axios from 'axios';
import { uploadFileToS3 } from '../../../utils/s3Utils';

// Mock dependencies
jest.mock('axios');
jest.mock('../../../utils/s3Utils');

describe('FileService', () => {
  let service: FileService;
  const mockUploadFileToS3 = uploadFileToS3 as jest.Mock;
  const mockAxiosGet = axios.get as jest.Mock;

  beforeEach(() => {
    service = new FileService();
    jest.clearAllMocks();
  });

  describe('saveFile', () => {
    it('should save file to S3 and return url', async () => {
      mockUploadFileToS3.mockResolvedValue({
        success: true,
        url: 'https://s3.example.com/test.txt'
      });

      const result = await service.saveFile('test.txt', 'hello world', 'user1', 'session1');

      expect(mockUploadFileToS3).toHaveBeenCalledWith(
        'hello world',
        'test.txt',
        'user1',
        'text/plain'
      );
      expect(result.success).toBe(true);
      expect(result.file_url).toBe('https://s3.example.com/test.txt');
    });

    it('should use cache for duplicate content', async () => {
      mockUploadFileToS3.mockResolvedValue({
        success: true,
        url: 'https://s3.example.com/test.txt'
      });

      // First call
      await service.saveFile('test.txt', 'hello world', 'user1', 'session1');
      
      // Second call should not upload
      mockUploadFileToS3.mockClear();
      const result = await service.saveFile('test.txt', 'hello world', 'user1', 'session1');

      expect(mockUploadFileToS3).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.file_url).toBe('https://s3.example.com/test.txt');
    });
  });

  describe('readFileContent', () => {
    it('should read text file from URL', async () => {
      mockAxiosGet.mockResolvedValue({
        data: Buffer.from('hello world'),
        headers: { 'content-type': 'text/plain' }
      });

      const result = await service.readFileContent('https://example.com/test.txt');

      expect(mockAxiosGet).toHaveBeenCalledWith('https://example.com/test.txt', expect.any(Object));
      expect(result.success).toBe(true);
      expect(result.content).toBe('hello world');
      expect(result.file_type).toBe('text');
    });

    it('should handle invalid URL', async () => {
      const result = await service.readFileContent('ftp://example.com');
      expect(result.success).toBe(false);
      expect(result.message).toContain('Invalid URL');
    });
  });
});
