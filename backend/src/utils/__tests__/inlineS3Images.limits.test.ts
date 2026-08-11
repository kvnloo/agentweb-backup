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

  it('keeps markup after a self-closing template start tag inert per HTML semantics', async () => {
    const url = 'https://agentweb-user-files.s3.amazonaws.com/users/u1/inert-after-template.png';
    const html = `<template/><img src="${url}">`;
    const fetcher: InlineImageFetcher = jest.fn().mockRejectedValue(
      new Error('template content must not be fetched'),
    );

    await expect(inlineS3ImagesAsDataUris(html, fetcher)).resolves.toEqual({
      html,
      inlined: 0,
      decodedBytes: 0,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('preserves existing data URIs without calling the fetcher', async () => {
    const html = '<img src="data:image/png;base64,aW1hZ2U=">';
    const fetcher: InlineImageFetcher = jest.fn();

    await expect(inlineS3ImagesAsDataUris(html, fetcher)).resolves.toEqual({
      html,
      inlined: 0,
      decodedBytes: 0,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('handles whitespace, single quotes, and valueless src attributes', async () => {
    const bytes = Buffer.from('image');
    const url = 'https://agentweb-user-files.s3.amazonaws.com/users/u1/spaced.png';
    const html = `<div src="ignored"></div><img src><img alt="x" src = '${url}'>`;
    const fetcher: InlineImageFetcher = jest.fn().mockResolvedValue({ buffer: bytes });

    const result = await inlineS3ImagesAsDataUris(html, fetcher);

    expect(result.html).toBe(
      `<div src="ignored"></div><img src><img alt="x" src = 'data:image/png;base64,${bytes.toString('base64')}'>`,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps unhandled sources unchanged while replacing a handled source', async () => {
    const bytes = Buffer.from('image');
    const owned = 'https://agentweb-user-files.s3.amazonaws.com/users/u1/owned.png';
    const foreign = 'https://cdn.example.com/foreign.png';
    const html = `<img src="${foreign}"><img src="${owned}">`;
    const fetcher: InlineImageFetcher = jest.fn(async (url) => (
      url === owned ? { buffer: bytes, contentType: 'image/png' } : null
    ));

    const result = await inlineS3ImagesAsDataUris(html, fetcher);

    expect(result.html).toContain(`src="${foreign}"`);
    expect(result.html).toContain(`data:image/png;base64,${bytes.toString('base64')}`);
  });

  it.each([
    [new Error('missing object'), /missing object.*confirm the asset/i],
    ['access denied', /access denied.*confirm the asset/i],
  ])('surfaces actionable fetch failures for %p', async (failure, expected) => {
    const url = 'https://agentweb-user-files.s3.amazonaws.com/users/u1/missing.png';
    const fetcher: InlineImageFetcher = jest.fn().mockRejectedValue(failure);

    await expect(inlineS3ImagesAsDataUris(`<img src="${url}">`, fetcher))
      .rejects.toThrow(expected);
  });

  it.each([
    ['https://assets.example/users/u1/chart.webp?version=1', undefined, 'image/webp'],
    ['https://assets.example/users/u1/chart.unknown', undefined, 'application/octet-stream'],
    ['https://assets.example/users/u1/chart.', undefined, 'application/octet-stream'],
    ['https://assets.example/users/u1/chart.png', 'text/plain', 'image/png'],
    ['https://assets.example/users/u1/chart', 'IMAGE/PNG', 'IMAGE/PNG'],
  ])('derives a safe MIME type for %s', async (url, contentType, expectedMime) => {
    const bytes = Buffer.from('image');
    const fetcher: InlineImageFetcher = jest.fn().mockResolvedValue({ buffer: bytes, contentType });

    const result = await inlineS3ImagesAsDataUris(`<img src="${url}">`, fetcher);

    expect(result.html).toContain(
      `data:${expectedMime};base64,${bytes.toString('base64')}`,
    );
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

  it('uses the configured default bucket when no bucket list is provided', async () => {
    const originalBucket = process.env.AWS_S3_BUCKET;
    process.env.AWS_S3_BUCKET = 'private-assets';
    const getObject = jest.spyOn(s3Utils, 'getS3ObjectAsBuffer').mockResolvedValue({
      buffer: Buffer.from('image'),
      contentType: 'image/png',
    });
    const fetcher = createDefaultS3ImageFetcher('u1');

    await expect(fetcher(
      'https://private-assets.s3.amazonaws.com/users/u1/default.png',
    )).resolves.toEqual({ buffer: Buffer.from('image'), contentType: 'image/png' });

    if (originalBucket === undefined) delete process.env.AWS_S3_BUCKET;
    else process.env.AWS_S3_BUCKET = originalBucket;
    getObject.mockRestore();
  });
});
