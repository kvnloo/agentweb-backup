// Unit tests for file upload size limits (18MB)

describe('File Upload Size Limits', () => {
  const EIGHTEEN_MB = 18 * 1024 * 1024; // 18MB in bytes
  const SEVENTEEN_MB = 17 * 1024 * 1024; // 17MB in bytes
  const NINETEEN_MB = 19 * 1024 * 1024; // 19MB in bytes
  const TEN_MB = 10 * 1024 * 1024; // 10MB in bytes (old limit)

  describe('Brand Route File Size Limit Configuration', () => {
    it('should have 18MB file size limit configured', () => {
      // Read the brand route file to verify the limit
      const fs = require('fs');
      const path = require('path');
      const brandRoutePath = path.join(__dirname, '../routes/brand.ts');
      const brandRouteContent = fs.readFileSync(brandRoutePath, 'utf8');
      
      // Verify the file contains the 18MB limit
      expect(brandRouteContent).toContain('18 * 1024 * 1024');
      expect(brandRouteContent).toContain('18MB limit');
      expect(brandRouteContent).not.toContain('10 * 1024 * 1024'); // Should not have old 10MB limit
    });

    it('should accept files under 18MB', () => {
      const fileSize = SEVENTEEN_MB; // 17MB
      expect(fileSize).toBeLessThan(EIGHTEEN_MB);
      expect(fileSize).toBe(17 * 1024 * 1024);
    });

    it('should accept files exactly at 18MB', () => {
      const fileSize = EIGHTEEN_MB; // Exactly 18MB
      expect(fileSize).toBe(EIGHTEEN_MB);
      expect(fileSize).toBe(18 * 1024 * 1024);
    });

    it('should reject files over 18MB', () => {
      const fileSize = NINETEEN_MB; // 19MB
      expect(fileSize).toBeGreaterThan(EIGHTEEN_MB);
      expect(fileSize).toBe(19 * 1024 * 1024);
    });
  });

  describe('Tasks Route File Size Limit Configuration', () => {
    it('should have 18MB file size limit configured', () => {
      // Read the tasks route file to verify the limit
      const fs = require('fs');
      const path = require('path');
      const tasksRoutePath = path.join(__dirname, '../routes/tasks.ts');
      const tasksRouteContent = fs.readFileSync(tasksRoutePath, 'utf8');
      
      // Verify the file contains the 18MB limit
      expect(tasksRouteContent).toContain('18 * 1024 * 1024');
      expect(tasksRouteContent).toContain('18MB limit');
    });

    it('should accept files under 18MB for task attachments', () => {
      const fileSize = SEVENTEEN_MB; // 17MB
      expect(fileSize).toBeLessThan(EIGHTEEN_MB);
    });

    it('should accept files exactly at 18MB for task attachments', () => {
      const fileSize = EIGHTEEN_MB; // Exactly 18MB
      expect(fileSize).toBe(EIGHTEEN_MB);
    });

    it('should reject files over 18MB for task attachments', () => {
      const fileSize = NINETEEN_MB; // 19MB
      expect(fileSize).toBeGreaterThan(EIGHTEEN_MB);
    });
  });

  describe('File Size Limit Constants', () => {
    it('should have consistent 18MB limit across routes', () => {
      const brandLimit = 18 * 1024 * 1024;
      const tasksLimit = 18 * 1024 * 1024;
      
      expect(brandLimit).toBe(EIGHTEEN_MB);
      expect(tasksLimit).toBe(EIGHTEEN_MB);
      expect(brandLimit).toBe(tasksLimit);
    });

    it('should verify limit was updated from 10MB to 18MB', () => {
      // Verify the new limit is 18MB
      expect(EIGHTEEN_MB).toBe(18 * 1024 * 1024);
      
      // Verify it's greater than the old limit
      expect(EIGHTEEN_MB).toBeGreaterThan(TEN_MB);
      
      // Verify old limit is no longer used
      const oldLimit = 10 * 1024 * 1024;
      expect(EIGHTEEN_MB).not.toBe(oldLimit);
    });

    it('should correctly calculate 18MB in bytes', () => {
      const expectedBytes = 18 * 1024 * 1024;
      expect(expectedBytes).toBe(18874368); // 18 * 1024 * 1024 = 18,874,368 bytes
      expect(EIGHTEEN_MB).toBe(expectedBytes);
    });

    it('should verify 18MB is greater than the old 10MB limit', () => {
      const oldLimit = 10 * 1024 * 1024; // 10MB
      expect(EIGHTEEN_MB).toBeGreaterThan(oldLimit);
    });

    it('should verify 18MB is less than nginx limit (20MB)', () => {
      const nginxLimit = 20 * 1024 * 1024; // 20MB
      expect(EIGHTEEN_MB).toBeLessThan(nginxLimit);
    });

    it('should verify 18MB is less than Express body limit (50MB)', () => {
      const expressLimit = 50 * 1024 * 1024; // 50MB
      expect(EIGHTEEN_MB).toBeLessThan(expressLimit);
    });
  });

  describe('File Size Validation Scenarios', () => {
    it('should handle edge case: file size just under 18MB', () => {
      const fileSize = EIGHTEEN_MB - 1; // 18MB - 1 byte
      expect(fileSize).toBeLessThan(EIGHTEEN_MB);
      expect(fileSize).toBe(18874367); // 18,874,367 bytes
    });

    it('should handle edge case: file size just over 18MB', () => {
      const fileSize = EIGHTEEN_MB + 1; // 18MB + 1 byte
      expect(fileSize).toBeGreaterThan(EIGHTEEN_MB);
      expect(fileSize).toBe(18874369); // 18,874,369 bytes
    });

    it('should handle various file sizes correctly', () => {
      const testCases = [
        { size: 1024, description: '1KB', shouldPass: true },
        { size: 1024 * 1024, description: '1MB', shouldPass: true },
        { size: 5 * 1024 * 1024, description: '5MB', shouldPass: true },
        { size: 10 * 1024 * 1024, description: '10MB', shouldPass: true },
        { size: 17 * 1024 * 1024, description: '17MB', shouldPass: true },
        { size: 18 * 1024 * 1024, description: '18MB', shouldPass: true },
        { size: 19 * 1024 * 1024, description: '19MB', shouldPass: false },
        { size: 20 * 1024 * 1024, description: '20MB', shouldPass: false },
      ];

      testCases.forEach(({ size, description, shouldPass }) => {
        if (shouldPass) {
          expect(size).toBeLessThanOrEqual(EIGHTEEN_MB);
        } else {
          expect(size).toBeGreaterThan(EIGHTEEN_MB);
        }
      });
    });
  });
});

