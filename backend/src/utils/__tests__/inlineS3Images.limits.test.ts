import {
  createDefaultS3ImageFetcher,
  inlineS3ImagesAsDataUris,
  MAX_INLINE_DOCUMENT_IMAGE_BYTES,
  MAX_INLINE_IMAGE_BYTES,
  type InlineImageFetcher,
} from '../inlineS3Images';
import * as s3Utils from '../s3Utils';

describe('inlineS3ImagesAsDataUris — ENG-278 bounded contract', () => {
  it('inlines an image at or below the 5 MB decoded-byte limit', async () => {
    const bytes = Buffer.from('private-image');
    const url = 'https://agentweb-user-files.s3.amazonaws.com/users/u1/chart.png';
    const fetcher: InlineImageFetcher = jest.fn().mockResolvedValue({
      buffer: bytes,
      contentType: 'image/png',
    });

    const result = await inlineS3ImagesAsDataUris(`<img src="${url}">`, fetcher);

    expect(result.html).toContain(`data:image/png;base64,${bytes.toString('base64')}`);
    expect(result.inlined).toBe(1);
    expect(result.decodedBytes).toBe(bytes.byteLength);
  });

  it('rejects an image over 5 MB with the asset and remediation in the error', async () => {
    const url = 'https://agentweb-user-files.s3.amazonaws.com/users/u1/huge.png';
    const fetcher: InlineImageFetcher = jest.fn().mockResolvedValue({
      buffer: Buffer.alloc(MAX_INLINE_IMAGE_BYTES + 1),
      contentType: 'image/png',
    });

    await expect(inlineS3ImagesAsDataUris(`<img src="${url}">`, fetcher)).rejects.toThrow(
      new RegExp(`5 MB.*${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*reduce`, 'i'),
    );
  });

  it('stops before exceeding 20 MB and reports how many images were already inlined', async () => {
    const urls = Array.from({ length: 5 }, (_, index) =>
      `https://agentweb-user-files.s3.amazonaws.com/users/u1/image-${index}.png`,
    );
    const fetcher: InlineImageFetcher = jest.fn(async (url) => ({
      buffer: Buffer.alloc(url.endsWith('image-4.png') ? 1 : MAX_INLINE_IMAGE_BYTES),
      contentType: 'image/png',
    }));
    const html = urls.map((url) => `<img src="${url}">`).join('');

    await expect(inlineS3ImagesAsDataUris(html, fetcher)).rejects.toThrow(
      /20 MB.*4 images.*reduce/i,
    );
    expect(MAX_INLINE_DOCUMENT_IMAGE_BYTES).toBe(20 * 1024 * 1024);
  });

  it('counts repeated image occurrences toward the aggregate decoded-byte limit', async () => {
    const url = 'https://agentweb-user-files.s3.amazonaws.com/users/u1/repeated.png';
    const fetcher: InlineImageFetcher = jest.fn().mockResolvedValue({
      buffer: Buffer.alloc(MAX_INLINE_IMAGE_BYTES),
      contentType: 'image/png',
    });
    const html = Array.from({ length: 5 }, () => `<img src="${url}">`).join('');

    await expect(inlineS3ImagesAsDataUris(html, fetcher)).rejects.toThrow(
      /20 MB.*4 images.*reduce/i,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('leaves unhandled images byte-identical', async () => {
    const html = '<img class="logo" src="https://cdn.example.com/logo.png">';
    const fetcher: InlineImageFetcher = jest.fn().mockResolvedValue(null);

    await expect(inlineS3ImagesAsDataUris(html, fetcher)).resolves.toEqual({
      html,
      inlined: 0,
      decodedBytes: 0,
    });
  });

  it('inlines a valid unquoted image src', async () => {
    const bytes = Buffer.from('private-image');
    const url = 'https://agentweb-user-files.s3.amazonaws.com/users/u1/unquoted.png';
    const fetcher: InlineImageFetcher = jest.fn().mockResolvedValue({
      buffer: bytes,
      contentType: 'image/png',
    });

    const result = await inlineS3ImagesAsDataUris(`<img alt=chart src=${url}>`, fetcher);

    expect(result.html).toBe(
      `<img alt=chart src="data:image/png;base64,${bytes.toString('base64')}">`,
    );
    expect(result.inlined).toBe(1);
  });

  it('ignores img-like text in comments, scripts, and templates', async () => {
    const inertUrl = 'https://agentweb-user-files.s3.amazonaws.com/users/u1/inert.png';
    const html = [
      `<!-- <img src="${inertUrl}"> -->`,
      `<script>const example = '<img src="${inertUrl}">';</script>`,
      `<template><img src="${inertUrl}"></template>`,
    ].join('');
    const fetcher: InlineImageFetcher = jest.fn().mockRejectedValue(
      new Error('inert image must not be fetched'),
    );

    await expect(inlineS3ImagesAsDataUris(html, fetcher)).resolves.toEqual({
      html,
      inlined: 0,
      decodedBytes: 0,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('fetches only same-bucket S3 assets with the per-image byte ceiling', async () => {
    const getObject = jest.spyOn(s3Utils, 'getS3ObjectAsBuffer').mockResolvedValue({
      buffer: Buffer.from('image'),
      contentType: 'image/png',
    });
    const fetcher = createDefaultS3ImageFetcher('u1', ['private-assets']);

    await expect(fetcher('https://private-assets.s3.us-west-2.amazonaws.com/users/u1/chart.png'))
      .resolves.toEqual({ buffer: Buffer.from('image'), contentType: 'image/png' });
    expect(getObject).toHaveBeenCalledWith(
      'users/u1/chart.png',
      'private-assets',
      MAX_INLINE_IMAGE_BYTES,
    );
    getObject.mockRestore();
  });

  it('does not fetch or sign foreign image URLs', async () => {
    const getObject = jest.spyOn(s3Utils, 'getS3ObjectAsBuffer');
    const fetcher = createDefaultS3ImageFetcher('u1', ['private-assets']);

    await expect(fetcher('https://cdn.example.com/chart.png')).resolves.toBeNull();
    expect(getObject).not.toHaveBeenCalled();
    getObject.mockRestore();
  });

  it('does not fetch another user\'s object from the shared bucket', async () => {
    const getObject = jest.spyOn(s3Utils, 'getS3ObjectAsBuffer');
    const fetcher = createDefaultS3ImageFetcher('u1', ['private-assets']);

    await expect(fetcher(
      'https://private-assets.s3.us-west-2.amazonaws.com/users/u2/chart.png',
    )).resolves.toBeNull();
    expect(getObject).not.toHaveBeenCalled();
    getObject.mockRestore();
  });
});
