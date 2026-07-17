// Tests for normalizeImageForVision — the decode/normalize step that makes
// user-uploaded logos analyzable by the vision APIs (ENG-370).
//
// Root cause the method fixes: describe_image built a base64 data URI labeled
// with whatever content-type S3 reported (or a default), without ever ensuring
// the bytes were a format the Anthropic/Bedrock vision APIs can decode. So:
//   - HEIC/AVIF/TIFF/BMP/SVG logos were relabeled "image/jpeg" downstream WITHOUT
//     re-encoding → declared media type didn't match the bytes → API 400.
//   - A supported format mislabeled "application/octet-stream" produced a
//     data:application/octet-stream;... URI that the block converters' image/*
//     regex dropped entirely → the model never received the image.
// normalizeImageForVision decodes the real bytes with sharp and either corrects
// the label (already-native format) or re-encodes to PNG (unsupported format).

jest.mock('sharp', () => jest.fn());

jest.mock('../services/db', () => ({
  getSession: jest.fn(),
  saveMessage: jest.fn(),
  updateSession: jest.fn(),
  getTask: jest.fn(),
  getTaskExecution: jest.fn(),
  getUserById: jest.fn(),
}));

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn().mockImplementation(() => ({
      get: jest.fn(), put: jest.fn(), update: jest.fn(), delete: jest.fn(),
      scan: jest.fn(), query: jest.fn(),
    })),
  },
  SecretsManager: jest.fn(),
  S3: jest.fn().mockImplementation(() => ({
    upload: jest.fn().mockReturnValue({
      promise: jest.fn().mockResolvedValue({ Location: 'mock-url', Key: 'mock-key' }),
    }),
  })),
}));

jest.mock('../services/chatbotService');
jest.mock('../services/settingsService');
jest.mock('../utils/secretsManager');

import { AgentModeService } from '../services/agentModeService';

const sharp = require('sharp') as jest.Mock;
const fakeBuffer = (size: number) => Buffer.alloc(size, 0x42);

// Private static helper; access it via a typed alias.
const normalize = (buffer: Buffer, contentType: string): Promise<{ buffer: Buffer; contentType: string }> =>
  (AgentModeService as any).normalizeImageForVision(buffer, contentType);

describe('normalizeImageForVision', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('passes a native image/png through unchanged and never touches sharp', async () => {
    sharp.mockReset();
    const buf = fakeBuffer(1024);
    const result = await normalize(buf, 'image/png');
    expect(result.buffer).toBe(buf);
    expect(result.contentType).toBe('image/png');
    expect(sharp).not.toHaveBeenCalled();
  });

  it('normalizes image/jpg to image/jpeg without re-encoding', async () => {
    sharp.mockReset();
    const buf = fakeBuffer(1024);
    const result = await normalize(buf, 'image/jpg');
    expect(result.contentType).toBe('image/jpeg');
    expect(result.buffer).toBe(buf);
    expect(sharp).not.toHaveBeenCalled();
  });

  it('relabels a mislabeled octet-stream that is actually PNG bytes (no re-encode)', async () => {
    const buf = fakeBuffer(2048);
    const pngInstance = {
      metadata: jest.fn().mockResolvedValue({ format: 'png' }),
      png: jest.fn().mockReturnThis(),
      toBuffer: jest.fn(),
    };
    sharp.mockReturnValue(pngInstance);

    const result = await normalize(buf, 'application/octet-stream');
    expect(result.contentType).toBe('image/png');
    // Bytes were already native — must NOT be re-encoded.
    expect(result.buffer).toBe(buf);
    expect(pngInstance.png).not.toHaveBeenCalled();
    expect(pngInstance.toBuffer).not.toHaveBeenCalled();
  });

  it('re-encodes a genuinely unsupported format (HEIC) to PNG', async () => {
    const original = fakeBuffer(4096);
    const converted = fakeBuffer(3000);
    const heicInstance = {
      metadata: jest.fn().mockResolvedValue({ format: 'heif' }),
      png: jest.fn().mockReturnThis(),
      toBuffer: jest.fn().mockResolvedValue(converted),
    };
    sharp.mockReturnValue(heicInstance);

    const result = await normalize(original, 'image/heic');
    expect(result.contentType).toBe('image/png');
    expect(result.buffer).toBe(converted);
    expect(heicInstance.png).toHaveBeenCalled();
  });

  it('re-encodes AVIF to PNG', async () => {
    const original = fakeBuffer(4096);
    const converted = fakeBuffer(2500);
    const avifInstance = {
      metadata: jest.fn().mockResolvedValue({ format: 'avif' }),
      png: jest.fn().mockReturnThis(),
      toBuffer: jest.fn().mockResolvedValue(converted),
    };
    sharp.mockReturnValue(avifInstance);

    const result = await normalize(original, 'image/avif');
    expect(result.contentType).toBe('image/png');
    expect(result.buffer).toBe(converted);
  });

  it('returns the original buffer and content type when sharp cannot decode', async () => {
    const buf = fakeBuffer(1500);
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const badInstance = {
      metadata: jest.fn().mockRejectedValue(new Error('unsupported image format')),
      png: jest.fn().mockReturnThis(),
      toBuffer: jest.fn(),
    };
    sharp.mockReturnValue(badInstance);

    const result = await normalize(buf, 'image/heic');
    // Best effort: unchanged when decode fails.
    expect(result.buffer).toBe(buf);
    expect(result.contentType).toBe('image/heic');
    consoleSpy.mockRestore();
  });

  it('treats a missing/empty content-type as non-native and decodes via sharp', async () => {
    const buf = fakeBuffer(2048);
    const jpegInstance = {
      metadata: jest.fn().mockResolvedValue({ format: 'jpeg' }),
      png: jest.fn().mockReturnThis(),
      toBuffer: jest.fn(),
    };
    sharp.mockReturnValue(jpegInstance);

    const result = await normalize(buf, '');
    expect(result.contentType).toBe('image/jpeg');
    expect(result.buffer).toBe(buf);
  });
});
