// Consolidates: describeVideo.enhanced + describeVideo.likeness-fix

import { AgentModeService } from '../services/agentModeService';
import axios from 'axios';
import { Readable } from 'stream';

jest.mock('axios');
jest.mock('../utils/secretsManager');
jest.mock('@google/genai');

const secretsManager = require('../utils/secretsManager');
const { GoogleGenAI } = require('@google/genai');

function makeVideoStream(data = 'fake-video-data') {
  const s = new Readable();
  s.push(data);
  s.push(null);
  return s;
}

function mockAxiosVideo(stream?: Readable) {
  (axios.get as jest.Mock).mockResolvedValue({
    data: stream || makeVideoStream(),
    headers: { 'content-type': 'video/mp4', 'content-length': '10240' }
  });
}

function mockAxiosImage(contentType: string) {
  (axios.get as jest.Mock).mockResolvedValue({
    data: makeVideoStream(),
    headers: { 'content-type': contentType, 'content-length': '2048' }
  });
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

  return { mockGenerateContent };
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
      mockAxiosImage(contentType);
      const result = await service.describeVideo('https://example.com/video.mp4');
      expect(result.success).toBe(false);
      expect(result.message).toContain('appears to be an image');
      expect(result.message).toContain(contentType);
      expect(result.message).toContain('describe_image');
    });

    it('should allow video files with .mp4 extension and no Content-Type header', async () => {
      secretsManager.getSecret.mockResolvedValue('test-api-key');
      (axios.get as jest.Mock).mockResolvedValue({ data: makeVideoStream(), headers: { 'content-type': '', 'content-length': '10240' } });
      const result = await service.describeVideo('https://example.com/video.mp4');
      if (!result.success) {
        expect(result.message).not.toContain('appears to be an image');
        expect(result.message).not.toContain('describe_image');
      }
    });

    it('should allow video files with video/mp4 Content-Type', async () => {
      secretsManager.getSecret.mockResolvedValue('test-api-key');
      mockAxiosVideo();
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
      mockAxiosVideo();
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
      mockAxiosVideo();
      mockGemini('A simple video description.');
      const result = await service.describeVideo('https://example.com/demo.mp4');
      expect(result.success).toBe(true);
      expect(result.transcript).toBeUndefined();
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
      mockAxiosVideo();
      mockGemini(fakeResponse);

      const result = await service.describeVideo('https://example.com/demo.mp4', undefined, { return_scenes: true });

      expect(result.success).toBe(true);
      expect(Array.isArray(result.scenes)).toBe(true);
      expect(result.scenes[0]).toHaveProperty('start');
      expect(result.scenes[0]).toHaveProperty('end');
      expect(result.scenes[0]).toHaveProperty('title');
    });

    it('should NOT include scenes when return_scenes is not set', async () => {
      mockAxiosVideo();
      mockGemini('A simple video description.');
      const result = await service.describeVideo('https://example.com/demo.mp4');
      expect(result.success).toBe(true);
      expect(result.scenes).toBeUndefined();
    });
  });

  describe('start_time / end_time parameters', () => {
    it('should include time range in Gemini prompt when start_time and end_time are provided', async () => {
      mockAxiosVideo();
      const { mockGenerateContent } = mockGemini('Focused description of the 0:30–1:00 segment.');

      const result = await service.describeVideo('https://example.com/demo.mp4', undefined, { start_time: '0:30', end_time: '1:00' });

      expect(result.success).toBe(true);
      const promptText = mockGenerateContent.mock.calls[0][0].contents[0].parts.find((p: any) => p.text)?.text || '';
      expect(promptText).toContain('0:30');
      expect(promptText).toContain('1:00');
    });

    it('should work with only start_time', async () => {
      mockAxiosVideo();
      const { mockGenerateContent } = mockGemini('Description from 1:00 onwards.');

      const result = await service.describeVideo('https://example.com/demo.mp4', undefined, { start_time: '1:00' });

      expect(result.success).toBe(true);
      const promptText = mockGenerateContent.mock.calls[0][0].contents[0].parts.find((p: any) => p.text)?.text || '';
      expect(promptText).toContain('1:00');
    });
  });

  describe('duration return field', () => {
    it('should return duration when Gemini response includes it', async () => {
      mockAxiosVideo();
      mockGemini(JSON.stringify({ description: 'A short video.', duration: 45.5 }));
      const result = await service.describeVideo('https://example.com/demo.mp4', undefined, { return_transcript: true });
      expect(result.success).toBe(true);
      expect(typeof result.duration).toBe('number');
    });
  });

  describe('combined structured output', () => {
    it('should return both transcript and scenes when both flags are set', async () => {
      mockAxiosVideo();
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
      // YouTube URLs must NOT be downloaded via axios — Gemini fetches them natively
      expect(axios.get as jest.Mock).not.toHaveBeenCalled();
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
      expect(axios.get as jest.Mock).not.toHaveBeenCalled();
      expect(Array.isArray(result.transcript)).toBe(true);
      expect(result.transcript[0]).toHaveProperty('text');
    });
  });

  describe('backward compatibility', () => {
    it('should work with no options (original signature)', async () => {
      mockAxiosVideo();
      mockGemini('This is a product demo video showing the main features.');
      const result = await service.describeVideo('https://example.com/demo.mp4');
      expect(result.success).toBe(true);
      expect(result.description).toBe('This is a product demo video showing the main features.');
      expect(result.videoUrl).toBe('https://example.com/demo.mp4');
    });

    it('should work with prompt only (original signature)', async () => {
      mockAxiosVideo();
      mockGemini('Description with custom focus.');
      const result = await service.describeVideo('https://example.com/demo.mp4', 'Focus on the branding elements only.');
      expect(result.success).toBe(true);
      expect(result.description).toBe('Description with custom focus.');
    });
  });
});
