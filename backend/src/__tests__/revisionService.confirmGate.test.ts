/**
 * ENG-936 — "Agent Mode Revision: Failed to Extract Asset URL"
 *
 * The Agent Mode image-revision prompt asks the model to edit the original asset,
 * which makes `inputImages` non-empty and trips the human-in-the-loop image-edit
 * confirmation gate in agentModeService.generate_image. That gate returns
 * `{ success: true, awaitingUserConfirmation: true }` and NO imageUrl, so the
 * revision produces nothing and the run is reported as an extraction failure.
 *
 * There is no human in the auto-revision loop: the user already approved this exact
 * source asset by asking for a revision of it in Slack. The revision prompt must
 * therefore carry the approval (confirm=true), and the confirmation state must
 * survive result minimisation so the oncall alert can name the real reason.
 */

import {
  buildAgentModeRevisionMessage,
  describeRevisionFailure,
} from '../services/revisionService';

const IMAGE_URL = 'https://example.com/users/u1/files/original.png';

describe('ENG-936: Agent Mode revision carries the user approval past the image-edit gate', () => {
  it('tells the model to call generate_image with confirm=true for an image revision', () => {
    const message = buildAgentModeRevisionMessage('image', IMAGE_URL, 'make the headline shorter');

    expect(message).toContain(IMAGE_URL);
    expect(message).toContain('make the headline shorter');
    // The approval the user already gave, expressed in the model-facing contract.
    expect(message).toContain('confirm=true');
  });

  it('still drives update_html_file for an html revision (unchanged contract)', () => {
    const message = buildAgentModeRevisionMessage('html', 'https://example.com/r.html', 'fix the table');

    expect(message).toContain('update_html_file');
    expect(message).not.toContain('confirm=true');
  });

  it('rejects an unsupported asset type instead of silently producing a prompt', () => {
    expect(() => buildAgentModeRevisionMessage('video' as any, IMAGE_URL, 'x')).toThrow(
      /Unsupported asset type/
    );
  });
});

describe('ENG-936: a revision blocked on confirmation is not reported as an extraction failure', () => {
  it('names the confirmation gate when a tool call is awaiting user confirmation', () => {
    const failure = describeRevisionFailure({
      toolCallFailed: false,
      toolCallFailureMessage: '',
      awaitingConfirmation: true,
    });

    expect(failure.subject).toMatch(/Confirmation/i);
    expect(failure.reason).toMatch(/confirmation/i);
  });

  it('still reports a genuine tool-call failure with its message', () => {
    const failure = describeRevisionFailure({
      toolCallFailed: true,
      toolCallFailureMessage: 'image service 500',
      awaitingConfirmation: false,
    });

    expect(failure.subject).toBe('Agent Mode Revision: Tool Call Failed');
    expect(failure.reason).toContain('image service 500');
  });

  it('falls back to the extraction failure only when nothing else explains it', () => {
    const failure = describeRevisionFailure({
      toolCallFailed: false,
      toolCallFailureMessage: '',
      awaitingConfirmation: false,
    });

    expect(failure.subject).toBe('Agent Mode Revision: Failed to Extract Asset URL');
    expect(failure.reason).toMatch(/Could not extract/i);
  });
});

describe('ENG-936: generate_image confirmation state survives result minimisation', () => {
  it('keeps awaitingUserConfirmation on a minimised generate_image result', async () => {
    const { agentModeService } = await import('../services/agentModeService');

    const minimal = (agentModeService as any).extractMinimalToolResult(
      {
        success: true,
        requiresConfirmation: true,
        awaitingUserConfirmation: true,
        message: 'Image edit requires user confirmation: …',
      },
      'generate_image'
    );

    expect(minimal.awaitingUserConfirmation).toBe(true);
    expect(minimal.success).toBe(true);
    expect(minimal.imageUrl).toBeUndefined();
  });

  it('does not invent the flag on an ordinary successful generation', async () => {
    const { agentModeService } = await import('../services/agentModeService');

    const minimal = (agentModeService as any).extractMinimalToolResult(
      { success: true, imageUrl: 'https://example.com/new.png', filename: 'new.png' },
      'generate_image'
    );

    expect(minimal.imageUrl).toBe('https://example.com/new.png');
    expect(minimal.awaitingUserConfirmation).toBeUndefined();
  });
});
