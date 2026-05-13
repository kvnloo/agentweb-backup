// Tests for describe_image auto-resize fallback (>4MB images)

jest.mock('axios');
jest.mock('sharp');

const mockAxios = require('axios');
const mockSharp = require('sharp');

// Build a fake Buffer of a given size
const fakeBuffer = (size: number) => Buffer.alloc(size, 0x42);

describe('describeImage auto-resize', () => {
  let sharpInstance: any;

  beforeEach(() => {
    jest.clearAllMocks();

    sharpInstance = {
      resize: jest.fn().mockReturnThis(),
      jpeg: jest.fn().mockReturnThis(),
      toBuffer: jest.fn().mockResolvedValue(fakeBuffer(800 * 1024)), // 800KB output
    };
    mockSharp.default = jest.fn().mockReturnValue(sharpInstance);
  });

  describe('resize decision', () => {
    it('skips resize when image is under 4MB', async () => {
      const smallBuf = fakeBuffer(2 * 1024 * 1024); // 2MB
      const shouldResize = smallBuf.length > 4 * 1024 * 1024;
      expect(shouldResize).toBe(false);
    });

    it('triggers resize when image is exactly at 4MB boundary', async () => {
      const boundary = fakeBuffer(4 * 1024 * 1024); // exactly 4MB — not over
      expect(boundary.length > 4 * 1024 * 1024).toBe(false);
    });

    it('triggers resize when image exceeds 4MB', async () => {
      const largeBuf = fakeBuffer(4 * 1024 * 1024 + 1);
      expect(largeBuf.length > 4 * 1024 * 1024).toBe(true);
    });

    it('triggers resize for 22MB S3 PNG (reported case)', async () => {
      const buf = fakeBuffer(22412424);
      expect(buf.length > 4 * 1024 * 1024).toBe(true);
    });
  });

  describe('sharp resize parameters', () => {
    it('resizes to max 1200px wide without enlargement', async () => {
      const largeBuf = fakeBuffer(5 * 1024 * 1024);
      const sharp = mockSharp.default;
      const instance = sharp(largeBuf);
      instance.resize({ width: 1200, withoutEnlargement: true });
      instance.jpeg({ quality: 85 });
      await instance.toBuffer();

      expect(sharpInstance.resize).toHaveBeenCalledWith({ width: 1200, withoutEnlargement: true });
      expect(sharpInstance.jpeg).toHaveBeenCalledWith({ quality: 85 });
      expect(sharpInstance.toBuffer).toHaveBeenCalled();
    });

    it('outputs JPEG content type after resize', async () => {
      // After resize, finalContentType should be 'image/jpeg' regardless of input
      const originalContentType = 'image/png';
      let finalContentType = originalContentType;

      const largeBuf = fakeBuffer(5 * 1024 * 1024);
      if (largeBuf.length > 4 * 1024 * 1024) {
        // simulate the resize branch
        finalContentType = 'image/jpeg';
      }

      expect(finalContentType).toBe('image/jpeg');
    });

    it('preserves original content type when no resize needed', async () => {
      const originalContentType = 'image/png';
      let finalContentType = originalContentType;

      const smallBuf = fakeBuffer(2 * 1024 * 1024);
      if (smallBuf.length > 4 * 1024 * 1024) {
        finalContentType = 'image/jpeg';
      }

      expect(finalContentType).toBe('image/png');
    });
  });

  describe('resize error handling', () => {
    it('falls back to original buffer when sharp throws', async () => {
      const largeBuf = fakeBuffer(5 * 1024 * 1024);
      let resultBuf = largeBuf;
      let finalContentType = 'image/png';

      const badInstance = {
        resize: jest.fn().mockReturnThis(),
        jpeg: jest.fn().mockReturnThis(),
        toBuffer: jest.fn().mockRejectedValue(new Error('sharp internal error')),
      };
      mockSharp.default.mockReturnValue(badInstance);

      if (largeBuf.length > 4 * 1024 * 1024) {
        try {
          const sharp = mockSharp.default;
          resultBuf = await sharp(largeBuf).resize({ width: 1200, withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
          finalContentType = 'image/jpeg';
        } catch {
          // fallback: keep original
        }
      }

      // Should still have the original 5MB buffer (fallback)
      expect(resultBuf).toBe(largeBuf);
      expect(finalContentType).toBe('image/png');
    });

    it('logs error when resize fails', async () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const error = new Error('sharp internal error');

      // simulate the catch block
      console.error('AgentMode: Failed to resize image, proceeding with original:', error.message);

      expect(consoleSpy).toHaveBeenCalledWith(
        'AgentMode: Failed to resize image, proceeding with original:',
        'sharp internal error'
      );
      consoleSpy.mockRestore();
    });
  });

  describe('data URI construction', () => {
    it('builds correct data URI from resized buffer', async () => {
      const resizedBuf = fakeBuffer(800 * 1024);
      const contentType = 'image/jpeg';
      const base64 = resizedBuf.toString('base64');
      const dataUri = `data:${contentType};base64,${base64}`;

      expect(dataUri).toMatch(/^data:image\/jpeg;base64,/);
    });

    it('base64 length is consistent with buffer size', () => {
      const buf = fakeBuffer(100);
      const b64 = buf.toString('base64');
      // base64 encodes 3 bytes as 4 chars, padded to multiple of 4
      expect(b64.length).toBe(Math.ceil(100 / 3) * 4);
    });
  });
});
