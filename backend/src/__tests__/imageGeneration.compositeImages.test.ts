// Tests for ImageService.compositeImages — deterministic, in-process compositing
// of N specific images into an exact layout (grid / row / column / honeycomb).
//
// This is the deterministic fallback for "exact element count" requests
// (e.g. "9 community avatars in a hexagon layout") that generative image
// models cannot reliably satisfy. The core guarantee under test: N input
// images always produce exactly N placed cells.

jest.mock('axios');
jest.mock('../utils/s3Utils');

const mockAxios = require('axios');
const { uploadFileToS3 } = require('../utils/s3Utils');

// Chainable sharp mock: every transform returns `this`, toBuffer resolves a buffer.
const sharpToBuffer = jest.fn();
jest.mock('sharp', () => {
  return jest.fn(() => ({
    resize: jest.fn().mockReturnThis(),
    composite: jest.fn().mockReturnThis(),
    png: jest.fn().mockReturnThis(),
    jpeg: jest.fn().mockReturnThis(),
    toBuffer: sharpToBuffer,
  }));
});

import { ImageService } from '../services/imageGeneration';

const fakeBuffer = (size: number) => Buffer.alloc(size, 0x42);

describe('ImageService.computeCompositeLayout', () => {
  const service = new ImageService();

  it('places exactly N cells for a default grid (the exact-count guarantee)', () => {
    for (const n of [1, 2, 7, 9, 16, 50]) {
      const layout = service.computeCompositeLayout(n, {});
      expect(layout.cells).toHaveLength(n);
    }
  });

  it('uses a near-square grid by default (9 -> 3 columns)', () => {
    const layout = service.computeCompositeLayout(9, { cellSize: 100, gap: 0 });
    // 3 columns, 3 rows: width and height both 300
    expect(layout.width).toBe(300);
    expect(layout.height).toBe(300);
    // first cell at origin, last cell (index 8) at row 2 col 2
    expect(layout.cells[0]).toEqual({ x: 0, y: 0, size: 100 });
    expect(layout.cells[8]).toEqual({ x: 200, y: 200, size: 100 });
  });

  it('honors an explicit columns override for grid', () => {
    const layout = service.computeCompositeLayout(9, { columns: 9, cellSize: 100, gap: 0 });
    // single row of 9
    expect(layout.width).toBe(900);
    expect(layout.height).toBe(100);
    expect(layout.cells.every((c) => c.y === 0)).toBe(true);
  });

  it('lays a row out horizontally (all cells share y=0)', () => {
    const layout = service.computeCompositeLayout(4, { layout: 'row', cellSize: 100, gap: 10 });
    expect(layout.cells).toHaveLength(4);
    expect(layout.cells.every((c) => c.y === 0)).toBe(true);
    expect(layout.height).toBe(100);
    expect(layout.width).toBe(4 * 100 + 3 * 10);
  });

  it('lays a column out vertically (all cells share x=0)', () => {
    const layout = service.computeCompositeLayout(3, { layout: 'column', cellSize: 100, gap: 10 });
    expect(layout.cells).toHaveLength(3);
    expect(layout.cells.every((c) => c.x === 0)).toBe(true);
    expect(layout.width).toBe(100);
    expect(layout.height).toBe(3 * 100 + 2 * 10);
  });

  it('offsets alternating rows for a honeycomb layout', () => {
    const layout = service.computeCompositeLayout(9, { layout: 'honeycomb', cellSize: 100, gap: 0 });
    expect(layout.cells).toHaveLength(9);
    // row 0 (cells 0-2) starts at x=0; row 1 (cells 3-5) is offset right by half a step
    expect(layout.cells[0].x).toBe(0);
    expect(layout.cells[3].x).toBe(50);
    // honeycomb uses a compressed vertical pitch (< cellSize), giving the packed look
    expect(layout.cells[3].y).toBeLessThan(100);
    expect(layout.cells[3].y).toBeGreaterThan(0);
  });

  it('clamps columns to at least 1', () => {
    const layout = service.computeCompositeLayout(3, { columns: 0, cellSize: 100, gap: 0 });
    expect(layout.cells).toHaveLength(3);
    expect(layout.width).toBeGreaterThan(0);
  });
});

describe('ImageService.compositeImages', () => {
  let service: ImageService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ImageService();
    sharpToBuffer.mockResolvedValue(fakeBuffer(1024));
    mockAxios.get = jest.fn().mockResolvedValue({
      data: new ArrayBuffer(8),
      headers: { 'content-type': 'image/png' },
    });
    (uploadFileToS3 as jest.Mock).mockResolvedValue({ success: true, url: 'https://s3/out.png' });
  });

  it('rejects an empty image list', async () => {
    const result = await service.compositeImages({ images: [], filename: 'out.png', userId: 'u1' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/at least one image/i);
  });

  it('rejects more than the maximum number of images', async () => {
    const images = Array.from({ length: 51 }, (_, i) => `https://img/${i}.png`);
    const result = await service.compositeImages({ images, filename: 'out.png', userId: 'u1' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/too many/i);
  });

  it('requires a filename', async () => {
    const result = await service.compositeImages({
      images: ['https://img/0.png'],
      filename: '',
      userId: 'u1',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/filename/i);
  });

  it('returns an error when the S3 upload fails', async () => {
    (uploadFileToS3 as jest.Mock).mockResolvedValue({ success: false, error: 'S3 down' });
    const result = await service.compositeImages({
      images: ['https://img/0.png', 'https://img/1.png'],
      filename: 'out.png',
      userId: 'u1',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/S3 down/);
  });

  it('composites 9 images into a honeycomb and uploads the result (happy path)', async () => {
    const images = Array.from({ length: 9 }, (_, i) => `https://img/${i}.png`);
    const result = await service.compositeImages({
      images,
      filename: 'avatars.png',
      userId: 'u1',
      layout: 'honeycomb',
      shape: 'circle',
    });
    expect(result.success).toBe(true);
    expect(result.imageUrl).toBe('https://s3/out.png');
    expect(result.filename).toBe('avatars.png');
    // one download per input image
    expect(mockAxios.get).toHaveBeenCalledTimes(9);
    expect(uploadFileToS3).toHaveBeenCalledTimes(1);
  });

  it('surfaces a thrown error from image processing without crashing', async () => {
    mockAxios.get = jest.fn().mockRejectedValue(new Error('network boom'));
    const result = await service.compositeImages({
      images: ['https://img/0.png'],
      filename: 'out.png',
      userId: 'u1',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/network boom/);
  });
});
