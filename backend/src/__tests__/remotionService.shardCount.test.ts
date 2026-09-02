// ENG-699: unit tests for computeRemotionShardCount — the pure helper that
// derives the shard-count metering quantity from durationInFrames/framesPerLambda.

import { computeRemotionShardCount } from '../services/remotionService';

describe('computeRemotionShardCount', () => {
  it('rounds up to a whole shard for a partial final shard', () => {
    // 1 second at 30fps = 30 frames; 61 frames at 60/lambda needs 2 shards.
    expect(computeRemotionShardCount(61, 60)).toBe(2);
  });

  it('returns exactly 1 shard for a duration that divides evenly', () => {
    expect(computeRemotionShardCount(120, 60)).toBe(2);
    expect(computeRemotionShardCount(60, 60)).toBe(1);
  });

  it('never returns 0 shards, even for a tiny duration', () => {
    expect(computeRemotionShardCount(1, 60)).toBe(1);
  });

  it('is defensive against non-finite/zero/negative inputs (never crashes metering)', () => {
    expect(computeRemotionShardCount(0, 60)).toBe(1);
    expect(computeRemotionShardCount(-5, 60)).toBe(1);
    expect(computeRemotionShardCount(NaN, 60)).toBe(1);
    expect(computeRemotionShardCount(120, 0)).toBe(1);
    expect(computeRemotionShardCount(120, -1)).toBe(1);
  });

  it('handles a large multi-shard render', () => {
    // 30s at 30fps = 900 frames; at 60 frames/lambda that's 15 shards.
    expect(computeRemotionShardCount(900, 60)).toBe(15);
  });
});
