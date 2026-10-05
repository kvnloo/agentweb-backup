/**
 * ENG-2103 F2 — proves emma/tools.ts's 10 video-generation/media-post-
 * processing tool execute() bodies call emma/impl/mediaVideo.ts directly
 * (not agentModeService.<method>) and forward args unchanged. Same pattern
 * as emmaTools.leads.test.ts / emmaTools.brandMarketStrategy.test.ts.
 *
 * generate_video's execute() also calls videoImpl.getVideoApiDefaultModel()
 * (ENG-2103 F2 cluster 21, extracted separately from this cluster — see
 * emma/impl/video.ts) when the caller omits videoModel. Not mocked here:
 * every generate_video test below supplies videoModel explicitly, so that
 * branch is never exercised in this suite.
 */

jest.mock('../emma/impl/mediaVideo', () => ({
  generateVideo: jest.fn(),
  muxVideoWithAudio: jest.fn(),
  generateVoiceover: jest.fn(),
  composeVideo: jest.fn(),
  listVideoCharacters: jest.fn(),
  getVideoCharacter: jest.fn(),
  createVideoCharacter: jest.fn(),
  deleteVideoCharacter: jest.fn(),
  removeC2PAFromImage: jest.fn(),
  removeImageBackground: jest.fn(),
}));

const MEDIA_VIDEO_CLUSTER_METHODS = [
  'generateVideo', 'muxVideoWithAudio', 'generateVoiceover', 'composeVideo',
  'listVideoCharacters', 'getVideoCharacter', 'createVideoCharacter',
  'deleteVideoCharacter', 'removeC2PAFromImage', 'removeImageBackground',
];

// agentModeService.<mediaVideoClusterMethod> must NOT be called by these 10
// tools anymore. generate_video's execute() no longer calls
// agentModeService.getVideoApiDefaultModel() at all (repointed to
// videoImpl.getVideoApiDefaultModel() by ENG-2103 F2 cluster 21) — the proxy
// below only throws for the 10 names this cluster actually owns; any other
// prop falling through to its default branch is otherwise-unexercised jest.fn()
// filler, not a real production call path.
jest.mock('../services/agentModeService', () => ({
  agentModeService: new Proxy(
    {},
    {
      get(_target, prop) {
        if (MEDIA_VIDEO_CLUSTER_METHODS.includes(String(prop))) {
          return () => {
            throw new Error(`agentModeService.${String(prop)} should not be called by the media/video cluster after ENG-2103 F2`);
          };
        }
        return jest.fn().mockResolvedValue({ success: true });
      },
    }
  ),
}));

import { emmaToolRegistry } from '../emma/registry';
import * as mediaVideoImpl from '../emma/impl/mediaVideo';
import '../emma/tools';

const mockMediaVideo = mediaVideoImpl as jest.Mocked<typeof mediaVideoImpl>;

describe('media/video cluster delegates to emma/impl/mediaVideo.ts (ENG-2103 F2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('generate_video forwards args in generateVideo’s parameter order and returns the result unchanged', async () => {
    const expected = { success: true, videoUrl: 'https://s3/video.mp4' };
    mockMediaVideo.generateVideo.mockResolvedValue(expected);

    const result = await emmaToolRegistry.getTool('generate_video')!.execute(
      {
        prompt: 'a cat', filename: 'cat.mp4', videoModel: 'veo-3.1-generate-preview',
        startFrame: 'sf', endFrame: 'ef', compose: true, composeParams: { a: 1 },
        durationSeconds: 8, useKeyframes: true, aspectRatio: '16:9', resolution: '1080p',
      },
      { userId: 'u1', sessionId: 's1' }
    );

    expect(mockMediaVideo.generateVideo).toHaveBeenCalledWith(
      'a cat', 'cat.mp4', 'u1', 's1', 'veo-3.1-generate-preview', 'sf', 'ef',
      true, { a: 1 }, 8, true, '16:9', '1080p'
    );
    expect(result).toBe(expected);
  });

  it('compose_video forwards clip_urls/filename/userId/sessionId and maps snake_case params to camelCase', async () => {
    const expected = { success: true, videoUrl: 'https://s3/composed.mp4' };
    mockMediaVideo.composeVideo.mockResolvedValue(expected);

    const result = await emmaToolRegistry.getTool('compose_video')!.execute(
      {
        clip_urls: ['a.mp4', 'b.mp4'], filename: 'out.mp4', brand_name: 'Acme',
        primary_color: '#111', secondary_color: '#222', clip_duration_seconds: 8,
        target_duration_seconds: 16, clip_durations_seconds: [8, 8],
      },
      { userId: 'u1', sessionId: 's1', renderDeadlineMs: 12345 }
    );

    expect(mockMediaVideo.composeVideo).toHaveBeenCalledWith(
      ['a.mp4', 'b.mp4'], 'out.mp4', 'u1', 's1',
      expect.objectContaining({ brandName: 'Acme', primaryColor: '#111', secondaryColor: '#222', renderDeadlineMs: 12345 }),
      8, 16, [8, 8]
    );
    expect(result).toBe(expected);
  });

  it('mux_video_with_audio forwards video_url/audio_url/filename/userId/sessionId', async () => {
    const expected = { success: true, videoUrl: 'https://s3/muxed.mp4' };
    mockMediaVideo.muxVideoWithAudio.mockResolvedValue(expected);

    const result = await emmaToolRegistry.getTool('mux_video_with_audio')!.execute(
      { video_url: 'v.mp4', audio_url: 'a.mp3', filename: 'out.mp4' },
      { userId: 'u1', sessionId: 's1' }
    );

    expect(mockMediaVideo.muxVideoWithAudio).toHaveBeenCalledWith('v.mp4', 'a.mp3', 'out.mp4', 'u1', 's1');
    expect(result).toBe(expected);
  });

  it('generate_voiceover forwards script/filename/userId/sessionId/voice/stability/similarity_boost', async () => {
    const expected = { success: true, audioUrl: 'https://s3/vo.mp3' };
    mockMediaVideo.generateVoiceover.mockResolvedValue(expected);

    const result = await emmaToolRegistry.getTool('generate_voiceover')!.execute(
      { script: 'Hello world', filename: 'vo.mp3', voice: 'george', stability: 0.5, similarity_boost: 0.75 },
      { userId: 'u1', sessionId: 's1' }
    );

    expect(mockMediaVideo.generateVoiceover).toHaveBeenCalledWith('Hello world', 'vo.mp3', 'u1', 's1', 'george', 0.5, 0.75);
    expect(result).toBe(expected);
  });

  it('list_characters forwards userId and returns the result unchanged', async () => {
    const expected = { success: true, characters: [] };
    mockMediaVideo.listVideoCharacters.mockResolvedValue(expected);

    const result = await emmaToolRegistry.getTool('list_characters')!.execute({}, { userId: 'u1' });

    expect(mockMediaVideo.listVideoCharacters).toHaveBeenCalledWith('u1');
    expect(result).toBe(expected);
  });

  it('get_character forwards character_id and returns the result unchanged', async () => {
    const expected = { success: true, character: { characterId: 'c1' } };
    mockMediaVideo.getVideoCharacter.mockResolvedValue(expected);

    const result = await emmaToolRegistry.getTool('get_character')!.execute({ character_id: 'c1' }, { userId: 'u1' });

    expect(mockMediaVideo.getVideoCharacter).toHaveBeenCalledWith('c1');
    expect(result).toBe(expected);
  });

  it('create_character forwards userId and maps snake_case args to the camelCase input shape', async () => {
    const expected = { success: true, character: { characterId: 'c1' } };
    mockMediaVideo.createVideoCharacter.mockResolvedValue(expected);

    const result = await emmaToolRegistry.getTool('create_character')!.execute(
      { name: 'Maya', description: 'confident woman', reference_image_url: 'https://s3/ref.png', prompt: 'a portrait' },
      { userId: 'u1' }
    );

    expect(mockMediaVideo.createVideoCharacter).toHaveBeenCalledWith('u1', {
      name: 'Maya', description: 'confident woman', referenceImageUrl: 'https://s3/ref.png',
      referenceImageKey: '', prompt: 'a portrait',
    });
    expect(result).toBe(expected);
  });

  it('delete_character forwards userId and character_id', async () => {
    const expected = { success: true, message: 'Character deleted' };
    mockMediaVideo.deleteVideoCharacter.mockResolvedValue(expected);

    const result = await emmaToolRegistry.getTool('delete_character')!.execute({ character_id: 'c1' }, { userId: 'u1' });

    expect(mockMediaVideo.deleteVideoCharacter).toHaveBeenCalledWith('u1', 'c1');
    expect(result).toBe(expected);
  });

  it('remove_c2pa_from_image forwards image_url/filename/userId and returns the result unchanged', async () => {
    const expected = { success: true, imageUrl: 'https://s3/clean.png' };
    mockMediaVideo.removeC2PAFromImage.mockResolvedValue(expected);

    const result = await emmaToolRegistry.getTool('remove_c2pa_from_image')!.execute(
      { image_url: 'https://s3/orig.png', filename: 'clean.png' },
      { userId: 'u1' }
    );

    expect(mockMediaVideo.removeC2PAFromImage).toHaveBeenCalledWith('https://s3/orig.png', 'clean.png', 'u1');
    expect(result).toBe(expected);
  });

  it('remove_image_background forwards image_url/filename/userId and the tolerance/surface_color options bag', async () => {
    const expected = { success: true, imageUrl: 'https://s3/transparent.png' };
    mockMediaVideo.removeImageBackground.mockResolvedValue(expected);

    const result = await emmaToolRegistry.getTool('remove_image_background')!.execute(
      { image_url: 'https://s3/orig.png', filename: 'transparent.png', tolerance: 32, surface_color: '#1a1a2e' },
      { userId: 'u1' }
    );

    expect(mockMediaVideo.removeImageBackground).toHaveBeenCalledWith('https://s3/orig.png', 'transparent.png', 'u1', {
      tolerance: 32,
      surfaceColor: '#1a1a2e',
    });
    expect(result).toBe(expected);
  });
});
