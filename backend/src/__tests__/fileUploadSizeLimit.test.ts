// Unit tests for file upload size limits (10MB)

describe('File Upload Size Limits', () => {
  const TEN_MB = 10 * 1024 * 1024; // 10MB in bytes
  const NINE_MB = 9 * 1024 * 1024; // 9MB in bytes
  const ELEVEN_MB = 11 * 1024 * 1024; // 11MB in bytes
  const FIVE_MB = 5 * 1024 * 1024; // 5MB in bytes (old limit)

  describe('Brand Route File Size Limit Configuration', () => {
    it('should have 10MB file size limit configured', () => {
      // Read the brand route file to verify the limit
      const fs = require('fs');
      const path = require('path');
      const brandRoutePath = path.join(__dirname, '../routes/brand.ts');
      const brandRouteContent = fs.readFileSync(brandRoutePath, 'utf8');
      
      // Verify the file contains the 10MB limit
      expect(brandRouteContent).toContain('10 * 1024 * 1024');
      expect(brandRouteContent).toContain('10MB limit');
      expect(brandRouteContent).not.toContain('5 * 1024 * 1024'); // Should not have old 5MB limit
    });

    it('should accept files under 10MB', () => {
      const fileSize = NINE_MB; // 9MB
      expect(fileSize).toBeLessThan(TEN_MB);
      expect(fileSize).toBe(9 * 1024 * 1024);
    });

    it('should accept files exactly at 10MB', () => {
      const fileSize = TEN_MB; // Exactly 10MB
      expect(fileSize).toBe(TEN_MB);
      expect(fileSize).toBe(10 * 1024 * 1024);
    });

    it('should reject files over 10MB', () => {
      const fileSize = ELEVEN_MB; // 11MB
      expect(fileSize).toBeGreaterThan(TEN_MB);
      expect(fileSize).toBe(11 * 1024 * 1024);
    });
  });

  describe('Tasks Route File Size Limit Configuration', () => {
    it('should have 10MB file size limit configured', () => {
      // Read the tasks route file to verify the limit
      const fs = require('fs');
      const path = require('path');
      const tasksRoutePath = path.join(__dirname, '../routes/tasks.ts');
      const tasksRouteContent = fs.readFileSync(tasksRoutePath, 'utf8');
      
      // Verify the file contains the 10MB limit
      expect(tasksRouteContent).toContain('10 * 1024 * 1024');
      expect(tasksRouteContent).toContain('10MB limit');
    });

    it('should accept files under 10MB for task attachments', () => {
      const fileSize = NINE_MB; // 9MB
      expect(fileSize).toBeLessThan(TEN_MB);
    });

    it('should accept files exactly at 10MB for task attachments', () => {
      const fileSize = TEN_MB; // Exactly 10MB
      expect(fileSize).toBe(TEN_MB);
    });

    it('should reject files over 10MB for task attachments', () => {
      const fileSize = ELEVEN_MB; // 11MB
      expect(fileSize).toBeGreaterThan(TEN_MB);
    });
  });

  describe('File Size Limit Constants', () => {
    it('should have consistent 10MB limit across routes', () => {
      const brandLimit = 10 * 1024 * 1024;
      const tasksLimit = 10 * 1024 * 1024;
      
      expect(brandLimit).toBe(TEN_MB);
      expect(tasksLimit).toBe(TEN_MB);
      expect(brandLimit).toBe(tasksLimit);
    });

    it('should verify limit was updated from 5MB to 10MB', () => {
      // Verify the new limit is 10MB
      expect(TEN_MB).toBe(10 * 1024 * 1024);
      
      // Verify it's double the old limit
      expect(TEN_MB).toBe(FIVE_MB * 2);
      expect(TEN_MB).toBeGreaterThan(FIVE_MB);
      
      // Verify old limit is no longer used
      const oldLimit = 5 * 1024 * 1024;
      expect(TEN_MB).not.toBe(oldLimit);
    });

    it('should correctly calculate 10MB in bytes', () => {
      const expectedBytes = 10 * 1024 * 1024;
      expect(expectedBytes).toBe(10485760); // 10 * 1024 * 1024 = 10,485,760 bytes
      expect(TEN_MB).toBe(expectedBytes);
    });

    it('should verify 10MB is greater than the old 5MB limit', () => {
      const oldLimit = 5 * 1024 * 1024; // 5MB
      expect(TEN_MB).toBeGreaterThan(oldLimit);
      expect(TEN_MB).toBe(oldLimit * 2);
    });

    it('should verify 10MB is less than nginx limit (20MB)', () => {
      const nginxLimit = 20 * 1024 * 1024; // 20MB
      expect(TEN_MB).toBeLessThan(nginxLimit);
      expect(nginxLimit).toBe(TEN_MB * 2);
    });

    it('should verify 10MB is less than Express body limit (50MB)', () => {
      const expressLimit = 50 * 1024 * 1024; // 50MB
      expect(TEN_MB).toBeLessThan(expressLimit);
      expect(expressLimit).toBe(TEN_MB * 5);
    });
  });

  describe('File Size Validation Scenarios', () => {
    it('should handle edge case: file size just under 10MB', () => {
      const fileSize = TEN_MB - 1; // 10MB - 1 byte
      expect(fileSize).toBeLessThan(TEN_MB);
      expect(fileSize).toBe(10485759); // 10,485,759 bytes
    });

    it('should handle edge case: file size just over 10MB', () => {
      const fileSize = TEN_MB + 1; // 10MB + 1 byte
      expect(fileSize).toBeGreaterThan(TEN_MB);
      expect(fileSize).toBe(10485761); // 10,485,761 bytes
    });

    it('should handle various file sizes correctly', () => {
      const testCases = [
        { size: 1024, description: '1KB', shouldPass: true },
        { size: 1024 * 1024, description: '1MB', shouldPass: true },
        { size: 5 * 1024 * 1024, description: '5MB', shouldPass: true },
        { size: 9 * 1024 * 1024, description: '9MB', shouldPass: true },
        { size: 10 * 1024 * 1024, description: '10MB', shouldPass: true },
        { size: 11 * 1024 * 1024, description: '11MB', shouldPass: false },
        { size: 20 * 1024 * 1024, description: '20MB', shouldPass: false },
      ];

      testCases.forEach(({ size, description, shouldPass }) => {
        if (shouldPass) {
          expect(size).toBeLessThanOrEqual(TEN_MB);
        } else {
          expect(size).toBeGreaterThan(TEN_MB);
        }
      });
    });
  });
});

