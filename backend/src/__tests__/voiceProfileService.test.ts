import {
  appendVoiceObservation,
  buildVoiceCard,
  formatVoiceCardPromptBlock,
  shouldCaptureVoiceEdit,
  summarizeVoiceEdit,
  VOICE_CARD_MAX_CHARS,
} from '../services/voiceProfileService';

describe('voiceProfileService', () => {
  it('summarizes opening-line and hashtag edits', () => {
    const draft = 'Excited to share our launch! #AI #startup';
    const approved = 'We shipped v2 today. #AI #product';
    const summary = summarizeVoiceEdit(draft, approved);
    expect(summary).toMatch(/Opening edited/);
    expect(summary).toMatch(/Added hashtags: #product/);
    expect(summary).toMatch(/Removed hashtags: #startup/);
  });

  it('returns empty summary when draft equals approved', () => {
    expect(summarizeVoiceEdit('same text', 'same text')).toBe('');
    expect(shouldCaptureVoiceEdit('same', 'same')).toBe(false);
  });

  it('builds a capped Voice Card from observations', () => {
    const first = appendVoiceObservation(undefined, {
      platform: 'twitter',
      summary: 'Shorter hook',
      approvedSnippet: 'Shipped.',
    });
    const second = appendVoiceObservation(first, {
      platform: 'twitter',
      summary: 'Removed hashtag spam',
      approvedSnippet: 'Clean post.',
    });

    expect(second.observations).toHaveLength(2);
    expect(second.voiceCard).toMatch(/Voice Card/);
    expect(second.voiceCard.length).toBeLessThanOrEqual(VOICE_CARD_MAX_CHARS);
  });

  it('formats prompt block only when card is non-empty', () => {
    expect(formatVoiceCardPromptBlock('')).toBe('');
    expect(formatVoiceCardPromptBlock('  ')).toBe('');
    expect(formatVoiceCardPromptBlock(buildVoiceCard([
      {
        platform: 'twitter',
        summary: 'Direct tone',
        approvedSnippet: 'Done.',
        recordedAt: '2026-01-01T00:00:00.000Z',
      },
    ]))).toMatch(/\[Author Voice Card\]/);
  });
});
