import {
  snapshotVoiceDraft,
  validateVoiceApprovalCapture,
} from '../experiments/voiceCaptureBinding';

describe('A12 voice capture binding', () => {
  const snap = snapshotVoiceDraft({
    sessionId: 's1',
    actionId: 'publish-7',
    platform: 'x',
    draft: 'original draft',
  });

  it('captures an edit only when approval binds to the exact draft snapshot', () => {
    expect(validateVoiceApprovalCapture(snap, {
      sessionId: 's1',
      actionId: 'publish-7',
      platform: 'x',
      draft: 'original draft',
      draftFingerprint: snap.fingerprint,
      approved: 'my edited draft',
    })).toEqual({ capture: true });
  });

  it('rejects an approval from another session or action', () => {
    expect(validateVoiceApprovalCapture(snap, {
      sessionId: 'other',
      actionId: 'publish-7',
      platform: 'x',
      draft: 'original draft',
      draftFingerprint: snap.fingerprint,
      approved: 'edit',
    })).toEqual({ capture: false, reason: 'session_mismatch' });

    expect(validateVoiceApprovalCapture(snap, {
      sessionId: 's1',
      actionId: 'publish-8',
      platform: 'x',
      draft: 'original draft',
      draftFingerprint: snap.fingerprint,
      approved: 'edit',
    })).toEqual({ capture: false, reason: 'action_mismatch' });
  });

  it('rejects a stale editor draft even when session and action still match', () => {
    expect(validateVoiceApprovalCapture(snap, {
      sessionId: 's1',
      actionId: 'publish-7',
      platform: 'x',
      draft: 'newer regenerated draft',
      draftFingerprint: snap.fingerprint,
      approved: 'my edit',
    })).toEqual({ capture: false, reason: 'draft_mismatch' });
  });

  it('does not learn from an unchanged approval', () => {
    expect(validateVoiceApprovalCapture(snap, {
      sessionId: 's1',
      actionId: 'publish-7',
      platform: 'x',
      draft: 'original draft',
      draftFingerprint: snap.fingerprint,
      approved: 'original draft',
    })).toEqual({ capture: false, reason: 'unchanged' });
  });
});
