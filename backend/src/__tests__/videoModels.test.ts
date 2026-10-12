// Google shut down the Veo preview models on 2026-10-22. Stored admin settings and
// old callers may still name them; they must resolve to gemini-omni-1.1-flash at
// read time (no data rewrite) instead of failing or silently using a dead model.

import {
  GEMINI_OMNI_VIDEO_MODEL,
  VIDEO_MODELS,
  isSupportedVideoModel,
  normalizeVideoModel,
  omniClipDurations,
  omniDurationParam,
} from '../services/videoModels';

const mockGetSetting = jest.fn();
jest.mock('../services/settingsService', () => ({
  settingsService: { getSetting: (...args: any[]) => mockGetSetting(...args) },
}));

import { getVideoApiDefaultModel } from '../emma/impl/video';

const RETIRED = ['veo-3.1-generate-preview', 'veo-3.1-fast-generate-preview', 'veo-3-generate-preview', 'veo-3.0-generate-preview'];

describe('video model ids', () => {
  it('offers exactly gemini-omni-1.1-flash and seedance-2.0', () => {
    expect([...VIDEO_MODELS]).toEqual(['gemini-omni-1.1-flash', 'seedance-2.0']);
  });

  it.each(RETIRED)('resolves retired %s to gemini-omni-1.1-flash', (legacy) => {
    expect(normalizeVideoModel(legacy)).toBe(GEMINI_OMNI_VIDEO_MODEL);
    expect(isSupportedVideoModel(legacy)).toBe(true);
  });

  it('leaves current ids unchanged and rejects unknown ones', () => {
    expect(normalizeVideoModel('seedance-2.0')).toBe('seedance-2.0');
    expect(normalizeVideoModel(undefined)).toBeUndefined();
    expect(isSupportedVideoModel('veo-2.0-generate-001')).toBe(false);
    expect(isSupportedVideoModel(undefined)).toBe(false);
  });
});

describe('getVideoApiDefaultModel (agent_mode_video_api_default_model setting)', () => {
  beforeEach(() => mockGetSetting.mockReset());

  it('maps a stored retired Veo id to gemini-omni-1.1-flash without rewriting the setting', async () => {
    mockGetSetting.mockResolvedValue({ settingValue: 'veo-3.1-generate-preview' });
    await expect(getVideoApiDefaultModel()).resolves.toBe('gemini-omni-1.1-flash');
    expect(mockGetSetting).toHaveBeenCalledTimes(1);
  });

  it('returns a stored current model as-is', async () => {
    mockGetSetting.mockResolvedValue({ settingValue: 'gemini-omni-1.1-flash' });
    await expect(getVideoApiDefaultModel()).resolves.toBe('gemini-omni-1.1-flash');
  });

  it('falls back to seedance-2.0 for an unsupported or missing setting', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockGetSetting.mockResolvedValue({ settingValue: 'not-a-model' });
    await expect(getVideoApiDefaultModel()).resolves.toBe('seedance-2.0');
    mockGetSetting.mockResolvedValue(null);
    await expect(getVideoApiDefaultModel()).resolves.toBe('seedance-2.0');
  });
});

// Live-verified 2026-10-08: response_format.duration must be a string like "5s"
// (integer 3–10); {"duration":5} is a 400 and "duration_seconds" is unknown.
describe('omniDurationParam', () => {
  it('formats as "<n>s", rounded and clamped to Omni\'s 3–10s', () => {
    expect(omniDurationParam(5)).toBe('5s');
    expect(omniDurationParam(4.4)).toBe('4s');
    expect(omniDurationParam(4.5)).toBe('5s');
    expect(omniDurationParam(2)).toBe('3s');
    expect(omniDurationParam(14)).toBe('10s');
  });
});

describe('omniClipDurations', () => {
  it('keeps <=10s requests as one exact-length clip (default 8s)', () => {
    expect(omniClipDurations(5)).toEqual([5]);
    expect(omniClipDurations(10)).toEqual([10]);
    expect(omniClipDurations(undefined)).toEqual([8]);
    expect(omniClipDurations(1)).toEqual([3]);
  });

  it('splits longer requests into <=10s clips that sum to the request', () => {
    expect(omniClipDurations(14)).toEqual([10, 4]);
    expect(omniClipDurations(20)).toEqual([10, 10]);
    expect(omniClipDurations(30)).toEqual([10, 10, 10]);
    expect(omniClipDurations(11)).toEqual([8, 3]);
    expect(omniClipDurations(21)).toEqual([10, 8, 3]);
    for (const s of [11, 12, 13, 21, 22, 25, 31, 47]) {
      const clips = omniClipDurations(s);
      expect(clips.reduce((a, b) => a + b, 0)).toBe(s);
      expect(clips.every((c) => c >= 3 && c <= 10)).toBe(true);
    }
  });
});
