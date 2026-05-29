// Tests for OpenAI -> Anthropic content block conversion (Vertex Claude vision).
//
// Regression: describe_image sent an OpenAI-style { type: 'image_url' } content block
// to Claude on Vertex AI, which rejected it with 400 "Input tag 'image_url' found using
// 'type' does not match expected tags (image, document, ...)". The fix converts image_url
// blocks to Anthropic-native { type: 'image', source: {...} } blocks.

import { AgentModeService } from '../services/agentModeService';

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

// The converter is a private static helper; access it via a typed alias.
const convert = (content: any): any[] =>
  (AgentModeService as any).convertContentToAnthropicBlocks(content);

describe('convertContentToAnthropicBlocks', () => {
  it('converts a base64 data-URI image_url block to an Anthropic base64 image block', () => {
    const dataUri = 'data:image/png;base64,iVBORw0KGgoAAAA=';
    const blocks = convert([
      { type: 'text', text: 'describe this' },
      { type: 'image_url', image_url: { url: dataUri } },
    ]);

    expect(blocks).toEqual([
      { type: 'text', text: 'describe this' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgoAAAA=' },
      },
    ]);
    // Must NOT leak the rejected OpenAI tag
    expect(JSON.stringify(blocks)).not.toContain('image_url');
  });

  it('normalizes image/jpg media type to image/jpeg', () => {
    const blocks = convert([
      { type: 'image_url', image_url: { url: 'data:image/jpg;base64,AAAA' } },
    ]);
    expect(blocks[0]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' },
    });
  });

  it('falls back to image/jpeg for unsupported data-URI media types', () => {
    const blocks = convert([
      { type: 'image_url', image_url: { url: 'data:image/tiff;base64,BBBB' } },
    ]);
    expect(blocks[0].source.media_type).toBe('image/jpeg');
    expect(blocks[0].source.data).toBe('BBBB');
  });

  it('converts a public http(s) URL image_url block to a url image source', () => {
    const blocks = convert([
      { type: 'image_url', image_url: { url: 'https://example.com/chart.png' } },
    ]);
    expect(blocks[0]).toEqual({
      type: 'image',
      source: { type: 'url', url: 'https://example.com/chart.png' },
    });
  });

  it('wraps a plain string into a single text block', () => {
    expect(convert('hello world')).toEqual([{ type: 'text', text: 'hello world' }]);
  });

  it('converts a string item inside the array to a text block', () => {
    expect(convert(['just text', { type: 'text', text: 'and more' }])).toEqual([
      { type: 'text', text: 'just text' },
      { type: 'text', text: 'and more' },
    ]);
  });

  it('stringifies non-object primitive items (number, null) inside the array', () => {
    const blocks = convert([42, null, { type: 'text', text: 'x' }]);
    expect(blocks).toEqual([
      { type: 'text', text: '42' },
      { type: 'text', text: '' },
      { type: 'text', text: 'x' },
    ]);
  });

  it('passes Anthropic-native blocks (image, tool_result) through unchanged', () => {
    const native = [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'X' } },
      { type: 'tool_result', tool_use_id: 'abc', content: 'ok' },
    ];
    expect(convert(native)).toEqual(native);
  });

  it('skips malformed data URIs (no crash, no image block emitted)', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const blocks = convert([
      { type: 'text', text: 'keep me' },
      { type: 'image_url', image_url: { url: 'data:not-a-valid-uri' } },
    ]);
    expect(blocks).toEqual([{ type: 'text', text: 'keep me' }]);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('returns an empty-text block for null/undefined content', () => {
    expect(convert(null)).toEqual([{ type: 'text', text: '' }]);
    expect(convert(undefined)).toEqual([{ type: 'text', text: '' }]);
  });

  it('stringifies unknown object block types as text', () => {
    const blocks = convert([{ type: 'video_url', video_url: { url: 'x' } }]);
    expect(blocks[0].type).toBe('text');
    expect(blocks[0].text).toContain('video_url');
  });
});
