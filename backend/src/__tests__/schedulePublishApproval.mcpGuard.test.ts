/**
 * ENG-803 — the publish opt-out must be writable ONLY by a human.
 *
 * This is the load-bearing assumption of the whole design, and it has been broken
 * once already: an earlier revision treated a publishing tool in
 * `requiredFunctionCalls` as owner consent, until review pointed out that
 * `manage_scheduled_chat` is an MCP tool the MODEL calls, and it PUTs that field
 * straight onto the schedule record. Honouring it let Emma grant herself standing
 * authority to post — the ENG-803 defect inverted, manufacturing consent to act
 * instead of a gate to avoid acting.
 *
 * The guard is BIDIRECTIONAL, which is why this matters even though the default is
 * "authorized": a model able to write `requirePublishApproval: true` could silence
 * its own publishing and then truthfully cite the block as its reason for never
 * posting — reproducing the reported outcome through a legitimate mechanism.
 *
 * This test reads the real tool definition as source text, so it fails if anyone
 * adds the field to the MCP surface regardless of how it is spelled or wired.
 */

import * as fs from 'fs';
import * as path from 'path';

const API_TOOLS = path.join(__dirname, '..', 'mcp', 'server', 'apiTools.ts');

describe('manage_scheduled_chat MCP surface — publish approval is not model-writable (ENG-803)', () => {
  const source = fs.readFileSync(API_TOOLS, 'utf8');

  it('reads the real tool definition (guards against a silently moved file)', () => {
    // If apiTools.ts is relocated this assertion fails loudly, rather than the
    // grep below passing vacuously against an empty string.
    expect(source.length).toBeGreaterThan(1000);
    expect(source).toContain('manage_scheduled_chat');
  });

  it('never exposes requirePublishApproval to the model', () => {
    expect(source).not.toContain('requirePublishApproval');
    expect(source).not.toContain('require_publish_approval');
  });

  it('exposes no publish-authorization field under any known spelling', () => {
    // Includes ENG-827's field names: whichever consent mechanism survives
    // reconciliation, none of them may become model-writable through this surface.
    for (const forbidden of [
      'requirePublishApproval',
      'require_publish_approval',
      'unattendedPublishAuthorized',
      'unattended_publish_authorized',
      'publishAuthorized',
      'publish_authorized',
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});

/**
 * ENG-2204 — same bidirectional-guard reasoning as above, for the Slack-send-approval
 * opt-out this ticket adds. A model able to write `requireSlackApproval: true` could
 * silence its own unattended Slack sends and then truthfully cite the withheld block
 * as its reason for never sending — the identical self-authorization/self-silencing
 * risk ENG-803's guard exists to prevent, just for a different field.
 */
describe('manage_scheduled_chat MCP surface — Slack-send approval is not model-writable (ENG-2204)', () => {
  const source = fs.readFileSync(API_TOOLS, 'utf8');

  it('never exposes requireSlackApproval to the model', () => {
    expect(source).not.toContain('requireSlackApproval');
    expect(source).not.toContain('require_slack_approval');
  });
});
