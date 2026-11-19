// ENG-2228: compose_video crashed on short clips with
//   "inputRange must be strictly monotonically increasing but got [0,10,-2,18]".
// The BrandedVideo composition fades its intro over [0, 10, d - 20, d] and its outro over
// [0, 12, d - 10, d] (d = the overlay's own length), and the backend sized each overlay at 15% of the
// video, so a 4s clip (120 frames) got an 18-frame intro. resolveOverlayDurations keeps every overlay
// long enough for its fade.

jest.mock('aws-sdk', () => ({
  __esModule: true,
  default: {
    SecretsManager: jest.fn().mockImplementation(() => ({
      getSecretValue: jest.fn().mockReturnValue({
        promise: () => Promise.resolve({ SecretString: JSON.stringify({ functionName: 'fn', serveUrl: 'https://example.com/serve', region: 'us-east-1' }) }),
      }),
    })),
  },
}));
jest.mock('../services/usageRecorderService', () => ({ recordVendorUsage: jest.fn().mockResolvedValue(undefined) }));
const mockRenderMediaOnLambda = jest.fn();
jest.mock('@remotion/lambda/client', () => ({
  renderMediaOnLambda: (...args: unknown[]) => mockRenderMediaOnLambda(...args),
  getRenderProgress: jest.fn().mockResolvedValue({ done: true, outputFile: 'https://out.example.com/final.mp4' }),
}));

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  MIN_INTRO_OVERLAY_FRAMES,
  MIN_OUTRO_OVERLAY_FRAMES,
  RemotionService,
  resolveOverlayDurations,
} from '../services/remotionService';

const strictlyIncreasing = (xs: number[]) => xs.every((x, i) => i === 0 || x > xs[i - 1]);
const introRange = (d: number) => [0, 10, d - 20, d];
const outroRange = (d: number) => [0, 12, d - 10, d];

describe('resolveOverlayDurations', () => {
  it('the reported case: a 4s clip (120 frames) used to get an 18-frame intro, now a valid one', () => {
    expect(strictlyIncreasing(introRange(18))).toBe(false); // the crash from the ticket: [0,10,-2,18]
    const { introDurationFrames, outroDurationFrames } = resolveOverlayDurations({ durationInFrames: 120, hasCta: true });
    expect(introDurationFrames).toBe(MIN_INTRO_OVERLAY_FRAMES);
    expect(outroDurationFrames).toBe(MIN_OUTRO_OVERLAY_FRAMES);
    expect(strictlyIncreasing(introRange(introDurationFrames))).toBe(true);
    expect(strictlyIncreasing(outroRange(outroDurationFrames))).toBe(true);
  });

  it('every video length from one frame to 30s gives fade keyframes Remotion accepts', () => {
    for (let frames = 1; frames <= 900; frames++) {
      for (const hasCta of [true, false]) {
        const { introDurationFrames, outroDurationFrames } = resolveOverlayDurations({ durationInFrames: frames, hasCta });
        expect(strictlyIncreasing(introRange(introDurationFrames))).toBe(true);
        expect(strictlyIncreasing(outroRange(outroDurationFrames))).toBe(true);
      }
    }
  });

  it('leaves videos that already worked exactly as they were: 15% of the video, capped at 90 frames', () => {
    expect(resolveOverlayDurations({ durationInFrames: 240, hasCta: true })).toEqual({ introDurationFrames: 36, outroDurationFrames: 36 });
    expect(resolveOverlayDurations({ durationInFrames: 900, hasCta: true })).toEqual({ introDurationFrames: 90, outroDurationFrames: 90 });
    expect(resolveOverlayDurations({ durationInFrames: 3000, hasCta: true })).toEqual({ introDurationFrames: 90, outroDurationFrames: 90 });
  });

  it('keeps the default outro length when there is no call to action (it is never rendered)', () => {
    expect(resolveOverlayDurations({ durationInFrames: 120, hasCta: false }).outroDurationFrames).toBe(90);
    expect(resolveOverlayDurations({ durationInFrames: 240, hasCta: false }).outroDurationFrames).toBe(90);
  });

  it('the minimums still match the fade keyframes written in the composition', () => {
    // If someone lengthens a fade in BrandedVideo.tsx, this fails until the minimums follow it.
    const source = readFileSync(join(__dirname, '../../../remotion-lambda/src/compositions/BrandedVideo.tsx'), 'utf8');
    const needed = (pattern: RegExp) => {
      const m = source.match(pattern);
      expect(m).not.toBeNull(); // the keyframes moved: update this test and the minimums together
      return Number(m![1]) + Number(m![2]) + 1; // [0, a, d - b, d] is increasing only when d > a + b
    };
    const introNeeds = needed(/const opacity = interpolate\(\s*frame,\s*\[0, (\d+), durationFrames - (\d+), durationFrames\]/);
    const outroNeeds = needed(/cardOpacity = interpolate\(\s*frame,\s*\[0, (\d+), durationFrames - (\d+), durationFrames\]/);
    expect(MIN_INTRO_OVERLAY_FRAMES).toBeGreaterThanOrEqual(introNeeds);
    expect(MIN_OUTRO_OVERLAY_FRAMES).toBeGreaterThanOrEqual(outroNeeds);
  });
});

describe('RemotionService.compose sends the composition valid overlay lengths (ENG-2228)', () => {
  it('a single 4s branded clip with a call to action is rendered with a 31-frame intro and a 23-frame outro', async () => {
    jest.clearAllMocks();
    mockRenderMediaOnLambda.mockResolvedValue({ bucketName: 'bucket', renderId: 'render-1' });
    const service = new RemotionService();
    (service as any).ensureRemotionCredentials = jest.fn().mockResolvedValue(undefined);

    await service.compose({
      clipUrl: 'https://example.com/clip.mp4',
      brandName: 'AgentWeb',
      primaryColor: '#111111',
      secondaryColor: '#222222',
      ctaText: 'Book a demo',
      filename: 'out.mp4',
      userId: 'user-abc',
      clipDurationSeconds: 4,
    } as any);

    const { inputProps } = mockRenderMediaOnLambda.mock.calls[0][0];
    expect(inputProps).toMatchObject({ durationInFrames: 120, introDurationFrames: 31, outroDurationFrames: 23 });
  });
});
