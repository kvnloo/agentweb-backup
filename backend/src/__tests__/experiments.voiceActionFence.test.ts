import { VoiceActionFence } from '../experiments/voiceActionFence';

describe('A5 voice serializer experiment', () => {
  it('rejects an older draft after a newer utterance wins', () => {
    const fence = new VoiceActionFence();
    const first = fence.issue('s1');
    const second = fence.issue('s1');

    expect(fence.canCommit(first)).toBe(false);
    expect(fence.canCommit(second)).toBe(true);
  });

  it('permits only one publish in flight per session', () => {
    const fence = new VoiceActionFence();
    const token = fence.issue('s1');

    expect(fence.beginPublish(token)).toBe(true);
    expect(fence.beginPublish(token)).toBe(false);
    fence.endPublish(token);
    expect(fence.beginPublish(token)).toBe(true);
  });

  it('does not let one session lock another', () => {
    const fence = new VoiceActionFence();
    const a = fence.issue('a');
    const b = fence.issue('b');

    expect(fence.beginPublish(a)).toBe(true);
    expect(fence.beginPublish(b)).toBe(true);
  });
});
