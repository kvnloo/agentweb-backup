/**
 * H-VOICE wiring: capture edits on publish + prompt injection helpers.
 */

import { chatbotDb } from './chatbotService';
import {
  appendVoiceObservation,
  formatVoiceCardPromptBlock,
  shouldCaptureVoiceEdit,
  summarizeVoiceEdit,
  type SessionVoiceProfile,
} from './voiceProfileService';

export async function captureVoiceEditOnPublish(params: {
  sessionId?: string;
  platform: string;
  draftContent?: string;
  approvedContent: string;
  existingProfile?: SessionVoiceProfile;
}): Promise<SessionVoiceProfile | null> {
  const { sessionId, platform, draftContent, approvedContent, existingProfile } = params;
  if (!sessionId) return null;
  if (!shouldCaptureVoiceEdit(draftContent, approvedContent)) return null;

  const summary = summarizeVoiceEdit(draftContent ?? '', approvedContent);
  const profile = appendVoiceObservation(existingProfile, {
    platform,
    summary,
    approvedSnippet: approvedContent.split('\n').find((l) => l.trim())?.trim() ?? approvedContent.slice(0, 160),
  });

  await chatbotDb.updateSessionVoiceProfile(sessionId, profile);
  return profile;
}

export function voiceCardPromptSuffix(profile: SessionVoiceProfile | undefined): string {
  return formatVoiceCardPromptBlock(profile?.voiceCard);
}
