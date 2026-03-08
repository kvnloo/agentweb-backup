import fs from 'fs';
import { findChromeExecutable, PUPPETEER_LAUNCH_ARGS } from '../../utils/browserUtils';

jest.mock('fs');

const mockFs = fs as jest.Mocked<typeof fs>;

describe('browserUtils', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('findChromeExecutable', () => {
    it('returns the first Chrome path that exists', () => {
      (mockFs.existsSync as jest.Mock).mockImplementation((p: string) =>
        p === '/usr/bin/google-chrome-stable'
      );

      const result = findChromeExecutable();
      expect(result).toBe('/usr/bin/google-chrome-stable');
    });

    it('returns undefined when no Chrome path exists', () => {
      (mockFs.existsSync as jest.Mock).mockReturnValue(false);

      const result = findChromeExecutable();
      expect(result).toBeUndefined();
    });
  });

  describe('PUPPETEER_LAUNCH_ARGS', () => {
    it('includes --no-sandbox', () => {
      expect(PUPPETEER_LAUNCH_ARGS).toContain('--no-sandbox');
    });
  });
});
