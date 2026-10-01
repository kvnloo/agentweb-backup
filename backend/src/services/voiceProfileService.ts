/**
 * H-VOICE: session-scoped Voice Card built from observed draft → approved edits.
 *
 * Phase 1 (session metadata only — durable user profile is #15, parked).
 */

export const VOICE_CARD_MAX_CHARS = 2000;

export interface VoiceObservation {
  platform: string;
  summary: string;
  approvedSnippet: string;
  recordedAt: string;
}

export interface SessionVoiceProfile {
  observations: VoiceObservation[];
  voiceCard: string;
  updatedAt: string;
}

export function summarizeVoiceEdit(draft: string, approved: string): string {
  const d = (draft ?? '').trim();
  const a = (approved ?? '').trim();
  if (!a) return '';
  if (!d || d === a) return '';

  const parts: string[] = [];
  const dFirst = d.split('\n').find((line) => line.trim())?.trim().slice(0, 120) ?? '';
  const aFirst = a.split('\n').find((line) => line.trim())?.trim().slice(0, 120) ?? '';
  if (dFirst && aFirst && dFirst !== aFirst) {
    parts.push(`Opening edited: "${dFirst}" → "${aFirst}"`);
  }

  if (Math.abs(d.length - a.length) >= 24) {
    parts.push(`Length ${d.length} → ${a.length} chars`);
  }

  const tags = (text: string) => [...text.matchAll(/#\w+/g)].map((m) => m[0]);
  const added = tags(a).filter((t) => !tags(d).includes(t));
  const removed = tags(d).filter((t) => !tags(a).includes(t));
  if (added.length) parts.push(`Added hashtags: ${added.join(', ')}`);
  if (removed.length) parts.push(`Removed hashtags: ${removed.join(', ')}`);

  if (d.includes('!') !== a.includes('!')) {
    parts.push(a.includes('!') ? 'User prefers exclamation emphasis' : 'User removed exclamation emphasis');
  }

  return parts.join('; ') || 'User edited draft before approving publish.';
}

export function buildVoiceCard(observations: VoiceObservation[], maxChars = VOICE_CARD_MAX_CHARS): string {
  if (!observations.length) return '';

  const header =
    'Voice Card (learned from this session — mirror the author\'s approved wording, rhythm, and hooks):\n';
  const lines = [...observations]
    .reverse()
    .slice(0, 24)
    .map((o) => {
      const snippet = o.approvedSnippet ? ` Example: "${o.approvedSnippet.slice(0, 160)}"` : '';
      return `- [${o.platform}] ${o.summary}${snippet}`;
    });

  let card = header + lines.join('\n');
  if (card.length > maxChars) {
    card = card.slice(0, maxChars - 3) + '...';
  }
  return card;
}

export function appendVoiceObservation(
  existing: SessionVoiceProfile | undefined,
  observation: Omit<VoiceObservation, 'recordedAt'>,
): SessionVoiceProfile {
  const recorded: VoiceObservation = {
    ...observation,
    recordedAt: new Date().toISOString(),
  };

  const observations = [...(existing?.observations ?? []), recorded].slice(-32);
  return {
    observations,
    voiceCard: buildVoiceCard(observations),
    updatedAt: recorded.recordedAt,
  };
}

export function formatVoiceCardPromptBlock(voiceCard: string | undefined): string {
  const card = (voiceCard ?? '').trim();
  if (!card) return '';
  return `\n\n[Author Voice Card]\n${card}\n[/Author Voice Card]`;
}

export function shouldCaptureVoiceEdit(draft: string | undefined, approved: string | undefined): boolean {
  const d = (draft ?? '').trim();
  const a = (approved ?? '').trim();
  return Boolean(a && d && d !== a);
}
