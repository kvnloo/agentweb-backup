import { createHash } from 'crypto';

export interface VoiceDraftSnapshot {
  sessionId: string;
  actionId: string;
  platform: string;
  draft: string;
  fingerprint: string;
}

export interface VoiceApprovalCapture {
  sessionId: string;
  actionId: string;
  platform: string;
  draft: string;
  draftFingerprint: string;
  approved: string;
}

export type VoiceCaptureDecision =
  | { capture: true }
  | { capture: false; reason: 'session_mismatch' | 'action_mismatch' | 'draft_mismatch' | 'unchanged' | 'empty' };

export function fingerprintVoiceDraft(draft: string): string {
  return createHash('sha256').update(draft, 'utf8').digest('hex');
}

export function snapshotVoiceDraft(params: {
  sessionId: string;
  actionId: string;
  platform: string;
  draft: string;
}): VoiceDraftSnapshot {
  return {
    ...params,
    fingerprint: fingerprintVoiceDraft(params.draft),
  };
}

export function validateVoiceApprovalCapture(
  snapshot: VoiceDraftSnapshot,
  capture: VoiceApprovalCapture,
): VoiceCaptureDecision {
  if (capture.sessionId !== snapshot.sessionId) return { capture: false, reason: 'session_mismatch' };
  if (capture.actionId !== snapshot.actionId) return { capture: false, reason: 'action_mismatch' };
  if (
    capture.draftFingerprint !== snapshot.fingerprint ||
    fingerprintVoiceDraft(capture.draft) !== snapshot.fingerprint
  ) {
    return { capture: false, reason: 'draft_mismatch' };
  }

  const draft = capture.draft.trim();
  const approved = capture.approved.trim();
  if (!draft || !approved) return { capture: false, reason: 'empty' };
  if (draft === approved) return { capture: false, reason: 'unchanged' };
  return { capture: true };
}
