// Consolidates: describeVideo.enhanced + describeVideo.likeness-fix

import { AgentModeService, __testHooks } from '../services/agentModeService';

jest.mock('../utils/secretsManager');
jest.mock('@google/genai');
// ENG-2840: a non-YouTube video is downloaded only through the SSRF-guarded caller-URL fetch.
jest.mock('../utils/callerUrlFetch', () => ({
  ...jest.requireActual('../utils/callerUrlFetch'),
  fetchCallerUrlBuffer: jest.fn(),
}));
const { fetchCallerUrlBuffer, CallerUrlBlockedError, CallerUrlTooLargeError } = require('../utils/callerUrlFetch');
const mockedFetch = fetchCallerUrlBuffer as jest.Mock;

const secretsManager = require('../utils/secretsManager');
const { GoogleGenAI } = require('@google/genai');

function mockVideoDownload(contentType = 'video/mp4', data = 'fake-video-data') {
  mockedFetch.mockResolvedValue({ buffer: Buffer.from(data), contentType, finalUrl: 'https://example.com/video.mp4' });
}

function mockGemini(responseText: string) {
  const mockFilesUpload = jest.fn().mockResolvedValue({ uri: 'gs://fake-bucket/video.mp4', name: 'files/fake-file-id', mimeType: 'video/mp4' });
  const mockFilesGet = jest.fn().mockResolvedValue({ state: 'ACTIVE' });
  const mockFilesDelete = jest.fn().mockResolvedValue({});
  const mockGenerateContent = jest.fn().mockResolvedValue({ text: responseText });

  GoogleGenAI.mockImplementation(() => ({
    files: { upload: mockFilesUpload, get: mockFilesGet, delete: mockFilesDelete },
    models: { generateContent: mockGenerateContent }
  }));

  return { mockGenerateContent, mockFilesUpload };
}

describe('AgentModeService - describeVideo', () => {
  let service: AgentModeService;

  beforeEach(() => {
    jest.clearAllMocks();
    secretsManager.getSecret.mockResolvedValue('test-gemini-api-key');
    service = new AgentModeService();
  });

  // ── Image rejection (Fix D) ───────────────────────────────────────────────

  describe('reject image files gracefully', () => {
    it.each(['.jpg', '.png', '.gif', '.webp'])('should reject image files by extension (%s)', async (ext) => {
      const result = await service.describeVideo(`https://example.com/file${ext}`);
      expect(result.success).toBe(false);
      expect(result.message).toContain('appears to be an image');
      expect(result.message).toContain(ext);
      expect(result.message).toContain('describe_image');
    });

    it.each(['image/jpeg', 'image/png'])('should reject by Content-Type header (%s)', async (contentType) => {
      secretsManager.getSecret.mockResolvedValue('test-api-key');
      mockVideoDownload(contentType);
      const result = await service.describeVideo('https://example.com/video.mp4');
      expect(result.success).toBe(false);
      expect(result.message).toContain('appears to be an image');
      expect(result.message).toContain(contentType);
      expect(result.message).toContain('describe_image');
    });

    it('should allow video files with .mp4 extension and no Content-Type header', async () => {
      secretsManager.getSecret.mockResolvedValue('test-api-key');
      mockVideoDownload('');
      const result = await service.describeVideo('https://example.com/video.mp4');
      if (!result.success) {
        expect(result.message).not.toContain('appears to be an image');
        expect(result.message).not.toContain('describe_image');
      }
    });

    it('should allow video files with video/mp4 Content-Type', async () => {
      secretsManager.getSecret.mockResolvedValue('test-api-key');
      mockVideoDownload();
      const result = await service.describeVideo('https://example.com/video.mp4');
      if (!result.success) {
        expect(result.message).not.toContain('appears to be an image');
        expect(result.message).not.toContain('describe_image');
      }
    });

    it('should handle malformed URLs gracefully', async () => {
      const result = await service.describeVideo('not-a-valid-url');
      expect(result.success).toBe(false);
      expect(result.message || result.error).toBeTruthy();
    });

    it('should reject empty video URL', async () => {
      const result = await service.describeVideo('');
      expect(result.success).toBe(false);
      expect(result.message).toContain('No video URL provided');
    });
  });

  // ── ENG-2840: the caller's video URL is fetched only through the SSRF-guarded fetch ──────────

  describe('guarded download', () => {
    it('downloads through the guarded fetch with the size cap, a total time limit and the caller', async () => {
      mockVideoDownload();
      mockGemini('A short clip.');
      await service.describeVideo('https://example.com/video.mp4', undefined, { userId: 'user-1' });
      expect(mockedFetch).toHaveBeenCalledWith('https://example.com/video.mp4', {
        tool: 'describe_video',
        userId: 'user-1',
        maxBytes: 100 * 1024 * 1024,
        timeoutMs: 180_000,
      });
    });

    it('answers a plain refusal for an internal address and sends nothing to Gemini', async () => {
      mockedFetch.mockRejectedValue(new CallerUrlBlockedError());
      const { mockGenerateContent, mockFilesUpload } = mockGemini('should not be used');
      const result = await service.describeVideo('http://169.254.169.254/latest/meta-data/video.mp4');
      expect(result).toEqual({ success: false, message: 'That URL cannot be fetched. Use a public https link.' });
      expect(mockFilesUpload).not.toHaveBeenCalled();
      expect(mockGenerateContent).not.toHaveBeenCalled();
    });

    it('answers the size limit when the video is too large', async () => {
      mockedFetch.mockRejectedValue(new CallerUrlTooLargeError(100 * 1024 * 1024));
      const result = await service.describeVideo('https://example.com/huge.mp4');
      expect(result.success).toBe(false);
      expect(result.message).toBe('Video file too large for analysis: it exceeds the limit of 100 MB');
    });

    it('says plainly when the download hits its time limit', async () => {
      mockedFetch.mockRejectedValue(Object.assign(new Error('canceled'), { name: 'CanceledError', code: 'ERR_CANCELED' }));
      const result = await service.describeVideo('https://example.com/slow.mp4');
      expect(result).toEqual({ success: false, message: 'The video did not download within 180 s. Use a smaller file or a faster host.' });
    });

    it('keeps the 100 MB cap when MAX_DOWNLOADED_VIDEO_SIZE_MB is not a number', async () => {
      const saved = process.env.MAX_DOWNLOADED_VIDEO_SIZE_MB;
      process.env.MAX_DOWNLOADED_VIDEO_SIZE_MB = 'lots';
      try {
        mockVideoDownload();
        mockGemini('A short clip.');
        await service.describeVideo('https://example.com/video.mp4');
        expect(mockedFetch).toHaveBeenCalledWith('https://example.com/video.mp4', expect.objectContaining({ maxBytes: 100 * 1024 * 1024 }));
      } finally {
        if (saved === undefined) delete process.env.MAX_DOWNLOADED_VIDEO_SIZE_MB;
        else process.env.MAX_DOWNLOADED_VIDEO_SIZE_MB = saved;
      }
    });

    it('refuses an empty download', async () => {
      mockVideoDownload('video/mp4', '');
      mockGemini('unused');
      const result = await service.describeVideo('https://example.com/empty.mp4');
      expect(result).toEqual({ success: false, message: 'Downloaded video file is empty' });
    });
  });

  // ── Enhanced features ─────────────────────────────────────────────────────

  describe('return_transcript parameter', () => {
    it('should include transcript in return when return_transcript=true', async () => {
      const fakeResponse = JSON.stringify({
        description: 'A product demo video.',
        transcript: [
          { start: 0, end: 5, text: 'Welcome to the demo.' },
          { start: 5, end: 10, text: 'Here is the main feature.' }
        ],
        duration: 10
      });
      mockVideoDownload();
      const { mockGenerateContent } = mockGemini(fakeResponse);

      const result = await service.describeVideo('https://example.com/demo.mp4', undefined, { return_transcript: true });

      expect(result.success).toBe(true);
      expect(Array.isArray(result.transcript)).toBe(true);
      expect(result.transcript[0]).toHaveProperty('start');
      expect(result.transcript[0]).toHaveProperty('end');
      expect(result.transcript[0]).toHaveProperty('text');
      expect(mockGenerateContent).toHaveBeenCalledWith(
        expect.objectContaining({
          contents: expect.arrayContaining([
            expect.objectContaining({ parts: expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('transcript') })]) })
          ])
        })
      );
    });

    it('should NOT include transcript when return_transcript is not set', async () => {
      mockVideoDownload();
      mockGemini('A simple video description.');
      const result = await service.describeVideo('https://example.com/demo.mp4');
      expect(result.success).toBe(true);
      expect(result.transcript).toBeUndefined();
    });
  });

  describe('timestamp accuracy (MM:SS prompt + parsing)', () => {
    it('should ask Gemini for MM:SS timestamps when transcript is requested', async () => {
      mockVideoDownload();
      const { mockGenerateContent } = mockGemini(JSON.stringify({
        description: 'demo', transcript: [{ start: '00:00', end: '00:05', text: 'hi' }], duration: '00:05'
      }));

      await service.describeVideo('https://example.com/demo.mp4', undefined, { return_transcript: true });

      const promptText = mockGenerateContent.mock.calls[0][0].contents[0].parts.find((p: any) => p.text)?.text || '';
      expect(promptText).toContain('MM:SS');
    });

    it('should normalize MM:SS transcript timestamps to numeric seconds', async () => {
      mockVideoDownload();
      mockGemini(JSON.stringify({
        description: 'A demo video.',
        transcript: [
          { start: '00:00', end: '00:05', text: 'Welcome.' },
          { start: '01:15', end: '01:20', text: 'Main feature.' }
        ],
        duration: '01:20'
      }));

      const result = await service.describeVideo('https://example.com/demo.mp4', undefined, { return_transcript: true });

      expect(result.success).toBe(true);
      expect(result.transcript[0].start).toBe(0);
      expect(result.transcript[0].end).toBe(5);
      expect(result.transcript[1].start).toBe(75);
      expect(result.transcript[1].end).toBe(80);
      expect(result.duration).toBe(80);
    });

    it('should normalize HH:MM:SS scene timestamps to numeric seconds', async () => {
      mockVideoDownload();
      mockGemini(JSON.stringify({
        description: 'A long video.',
        scenes: [{ start: '01:00:30', end: '01:01:00', title: 'Late scene', description: 'x' }],
        duration: '01:01:00'
      }));

      const result = await service.describeVideo('https://example.com/demo.mp4', undefined, { return_scenes: true });

      expect(result.success).toBe(true);
      expect(result.scenes[0].start).toBe(3630);
      expect(result.scenes[0].end).toBe(3660);
    });

    it('should leave already-numeric timestamps unchanged (backward compatible)', async () => {
      mockVideoDownload();
      mockGemini(JSON.stringify({
        description: 'A demo video.',
        transcript: [{ start: 0, end: 5.5, text: 'Welcome.' }],
        duration: 5.5
      }));

      const result = await service.describeVideo('https://example.com/demo.mp4', undefined, { return_transcript: true });

      expect(result.success).toBe(true);
      expect(result.transcript[0].start).toBe(0);
      expect(result.transcript[0].end).toBe(5.5);
      expect(result.duration).toBe(5.5);
    });
  });

  describe('parseTimecodeToSeconds helper', () => {
    const parse = __testHooks.parseTimecodeToSeconds;
    it.each([
      ['00:00', 0],
      ['00:05', 5],
      ['1:15', 75],
      ['01:15', 75],
      ['01:00:30', 3630],
      ['10', 10],
      ['5.5', 5.5],
      [12, 12],
      [0, 0],
    ])('parses %s -> %s', (input, expected) => {
      expect(parse(input as any)).toBe(expected);
    });

    it.each([
      [undefined],
      [null],
      ['not-a-time'],
      [''],
    ])('returns undefined for invalid input %s', (input) => {
      expect(parse(input as any)).toBeUndefined();
    });
  });

  describe('return_scenes parameter', () => {
    it('should include scenes in return when return_scenes=true', async () => {
      const fakeResponse = JSON.stringify({
        description: 'A product demo video.',
        scenes: [
          { start: 0, end: 8, title: 'Introduction', description: 'Speaker introduces the product' },
          { start: 8, end: 20, title: 'Feature Demo', description: 'Live walkthrough of key features' }
        ],
        duration: 20
      });
      mockVideoDownload();
      mockGemini(fakeResponse);

      const result = await service.describeVideo('https://example.com/demo.mp4', undefined, { return_scenes: true });

      expect(result.success).toBe(true);
      expect(Array.isArray(result.scenes)).toBe(true);
      expect(result.scenes[0]).toHaveProperty('start');
      expect(result.scenes[0]).toHaveProperty('end');
      expect(result.scenes[0]).toHaveProperty('title');
    });

    it('should NOT include scenes when return_scenes is not set', async () => {
      mockVideoDownload();
      mockGemini('A simple video description.');
      const result = await service.describeVideo('https://example.com/demo.mp4');
      expect(result.success).toBe(true);
      expect(result.scenes).toBeUndefined();
    });
  });

  describe('start_time / end_time parameters', () => {
    it('should include time range in Gemini prompt when start_time and end_time are provided', async () => {
      mockVideoDownload();
      const { mockGenerateContent } = mockGemini('Focused description of the 0:30–1:00 segment.');

      const result = await service.describeVideo('https://example.com/demo.mp4', undefined, { start_time: '0:30', end_time: '1:00' });

      expect(result.success).toBe(true);
      const promptText = mockGenerateContent.mock.calls[0][0].contents[0].parts.find((p: any) => p.text)?.text || '';
      expect(promptText).toContain('0:30');
      expect(promptText).toContain('1:00');
    });

    it('should work with only start_time', async () => {
      mockVideoDownload();
      const { mockGenerateContent } = mockGemini('Description from 1:00 onwards.');

      const result = await service.describeVideo('https://example.com/demo.mp4', undefined, { start_time: '1:00' });

      expect(result.success).toBe(true);
      const promptText = mockGenerateContent.mock.calls[0][0].contents[0].parts.find((p: any) => p.text)?.text || '';
      expect(promptText).toContain('1:00');
    });
  });

  describe('duration return field', () => {
    it('should return duration when Gemini response includes it', async () => {
      mockVideoDownload();
      mockGemini(JSON.stringify({ description: 'A short video.', duration: 45.5 }));
      const result = await service.describeVideo('https://example.com/demo.mp4', undefined, { return_transcript: true });
      expect(result.success).toBe(true);
      expect(typeof result.duration).toBe('number');
    });
  });

  describe('combined structured output', () => {
    it('should return both transcript and scenes when both flags are set', async () => {
      mockVideoDownload();
      mockGemini(JSON.stringify({
        description: 'A marketing video.',
        transcript: [{ start: 0, end: 4, text: 'Buy our product today.' }],
        scenes: [{ start: 0, end: 4, title: 'CTA', description: 'Call to action' }],
        duration: 4
      }));

      const result = await service.describeVideo('https://example.com/demo.mp4', undefined, { return_transcript: true, return_scenes: true });

      expect(result.success).toBe(true);
      expect(result.transcript).toBeDefined();
      expect(result.scenes).toBeDefined();
      expect(result.duration).toBeDefined();
    });
  });

  describe('YouTube URL handling', () => {
    it.each([
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtu.be/dQw4w9WgXcQ',
      'https://youtube.com/shorts/abc123'
    ])('should pass YouTube URLs directly to Gemini without downloading (%s)', async (ytUrl) => {
      const { mockGenerateContent } = mockGemini('A YouTube interview about agentic AI.');

      const result = await service.describeVideo(ytUrl);

      expect(result.success).toBe(true);
      // YouTube URLs must NOT be downloaded by the server — Gemini fetches them natively
      expect(mockedFetch).not.toHaveBeenCalled();
      // The raw YouTube URL is handed to Gemini as fileData.fileUri
      const parts = mockGenerateContent.mock.calls[0][0].contents[0].parts;
      const fileDataPart = parts.find((p: any) => p.fileData);
      expect(fileDataPart?.fileData?.fileUri).toBe(ytUrl);
    });

    it('should return a timestamped transcript for a YouTube URL when return_transcript=true', async () => {
      mockGemini(JSON.stringify({
        description: 'An interview about agentic AI.',
        transcript: [
          { start: 0, end: 6, text: 'Today we discuss agentic AI.' },
          { start: 6, end: 12, text: 'It changes how software is built.' }
        ],
        duration: 12
      }));

      const result = await service.describeVideo(
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        undefined,
        { return_transcript: true }
      );

      expect(result.success).toBe(true);
      expect(mockedFetch).not.toHaveBeenCalled();
      expect(Array.isArray(result.transcript)).toBe(true);
      expect(result.transcript[0]).toHaveProperty('text');
    });
  });

  describe('backward compatibility', () => {
    it('should work with no options (original signature)', async () => {
      mockVideoDownload();
      mockGemini('This is a product demo video showing the main features.');
      const result = await service.describeVideo('https://example.com/demo.mp4');
      expect(result.success).toBe(true);
      expect(result.description).toBe('This is a product demo video showing the main features.');
      expect(result.videoUrl).toBe('https://example.com/demo.mp4');
    });

    it('should work with prompt only (original signature)', async () => {
      mockVideoDownload();
      mockGemini('Description with custom focus.');
      const result = await service.describeVideo('https://example.com/demo.mp4', 'Focus on the branding elements only.');
      expect(result.success).toBe(true);
      expect(result.description).toBe('Description with custom focus.');
    });
  });
});
