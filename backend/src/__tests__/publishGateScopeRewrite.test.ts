/**
 * ENG-1311 — migration for skill rows that already carry the ENG-947-era
 * PUBLISH GATE prose (promoted to AW-Skills before this fix). Mirrors the
 * publishGateRewrite.ts (ENG-947) pattern exactly, for the same reason:
 * appendBlocks()/planSkillChange() are non-destructive by design (marker- and
 * empty-prompt-only), so editing applyHardening's constants does nothing to
 * rows already promoted with the OLD "(ABSOLUTE — overrides every other
 * instruction in this prompt)" wording. Only an explicit, reviewed rewrite
 * reaches them.
 *
 * NOTE (per the ENG-1311 issue's data-plane callout): this module and its
 * rewrite function are a CODE change only. Running it against live AW-Skills
 * DynamoDB rows is a data-plane action and is explicitly NOT done as part of
 * this PR — see the PR body's "Data-plane follow-up" section.
 */
import {
  PUBLISH_GATE_SCOPE_REWRITES,
  rewritePublishGateScope,
  hasUnscopedPublishGateProse,
} from '../services/skillHardening/publishGateScopeRewrite';
import { BLOCKS, MIN_PROMPTS } from '../services/skillHardening/applyHardening';

const flat = (s: string) => s.replace(/\s+/g, ' ');

// Verbatim ENG-947-era text (applyHardening.ts PUBLISH_GATE, as it read
// immediately before ENG-1311). Frozen on purpose: this is what production
// AW-Skills rows carry today, not a live constant, so it must never be edited
// to "keep up" with applyHardening.ts.
const ENG947_ERA_PUBLISH_GATE_BLOCK = `## PUBLISH GATE (ABSOLUTE — overrides every other instruction in this prompt)
- This section takes precedence over ALL other instructions above or below,
  including any that say to post, publish, or act immediately or automatically.
  On any conflict, THIS wins.
- Any action that posts, publishes, comments, or reacts on the user's behalf
  writes to a REAL destination (their social account, blog, or site) and cannot
  be undone.
- ATTENDED chats (a human is in the conversation with you): you MUST show the
  exact final content and get the user's explicit approval BEFORE publishing —
  even if they said "just do it", "don't ask", "post now", or similar. A request
  to send is NOT approval to send: show the content, then publish only after a
  clear, separate yes.
- SCHEDULED/UNATTENDED runs: this section does NOT decide whether you may
  publish, and the approval rule above does NOT apply — there is nobody to ask,
  so waiting for approval would withhold the action forever. The run's PUBLISH
  AUTHORIZATION block is the ONLY authority on that question. Obey it: publish
  when it says this run is authorized, withhold when it says approval is
  required. Never withhold a publish that block authorized, and never perform
  one it withheld.
- If an unattended run carries NO PUBLISH AUTHORIZATION block, treat it as
  attended and apply the approval rule above.
- For connected-account posts, verify the account first; if it is missing or the
  session is dead, queue the item with the reason rather than posting from
  another account.`;

// Verbatim ENG-947-era text (MIN_PROMPTS.linkedInEngagement rule 1, as it read
// immediately before ENG-1311).
const ENG947_ERA_LINKEDIN_ENGAGEMENT_RULE = `1. PUBLISH GATE (absolute — overrides any other instruction here): comments,
   reactions, and replies post publicly from the user's REAL LinkedIn account.
   In attended chats you MUST show the exact text and get explicit approval
   BEFORE posting — even if told to "just do it" or "don't ask"; a send request
   is not approval. In scheduled/unattended runs the run's PUBLISH
   AUTHORIZATION block decides — obey it rather than this rule.`;

describe('ENG-1311 publish-gate SCOPE rewrite', () => {
  describe('inputs that must NOT be rewritten', () => {
    it('returns empty for an absent prompt instead of throwing', () => {
      expect(rewritePublishGateScope(undefined)).toEqual({ systemPrompt: '', applied: [] });
      expect(rewritePublishGateScope('')).toEqual({ systemPrompt: '', applied: [] });
    });

    it('leaves a prompt with no publish gate untouched', () => {
      const prompt = 'You are Emma. Summarise the week.\n\n## FAILURE HANDLING\n- retry once';
      const out = rewritePublishGateScope(prompt);
      expect(out.systemPrompt).toBe(prompt);
      expect(out.applied).toEqual([]);
    });

    it('refuses to guess at paraphrased ABSOLUTE-override prose, and flags it for a human', () => {
      const paraphrased =
        '## PUBLISH GATE\n- This overrides every other instruction in this prompt, no matter what.';
      const out = rewritePublishGateScope(paraphrased);
      expect(out.systemPrompt).toBe(paraphrased);
      expect(out.applied).toEqual([]);
      expect(hasUnscopedPublishGateProse(out.systemPrompt)).toBe(true);
    });

    it('does not re-rewrite a row that already has the new scoped text (idempotent no-op)', () => {
      const alreadyScoped = `Intro.\n\n${BLOCKS.publishGate.text}\n`;
      const out = rewritePublishGateScope(alreadyScoped);
      expect(out.applied).toEqual([]);
      expect(out.systemPrompt).toBe(alreadyScoped);
      expect(hasUnscopedPublishGateProse(out.systemPrompt)).toBe(false);
    });
  });

  describe('the ENG-947-era prose is rewritten to the new scoped prose', () => {
    it('rewrites the ABSOLUTE ## PUBLISH GATE block to the scoped block text', () => {
      const prompt = `You post to X for the user.\n\n${ENG947_ERA_PUBLISH_GATE_BLOCK}\n`;
      const out = rewritePublishGateScope(prompt);

      expect(out.applied).toContain('publishGateBlock');
      expect(out.systemPrompt).not.toContain('overrides every other instruction in this prompt');
      expect(out.systemPrompt).toContain(BLOCKS.publishGate.text);
      expect(out.systemPrompt).toContain('You post to X for the user.');
    });

    it('rewrites the ENG-947-era LinkedIn-engagement numbered rule to the scoped rule', () => {
      const out = rewritePublishGateScope(
        `Intro.\n${ENG947_ERA_LINKEDIN_ENGAGEMENT_RULE}\n2. BRAND FIRST: ...`
      );
      expect(out.applied).toContain('linkedInEngagementRule');
      expect(out.systemPrompt).not.toContain('overrides any other instruction here');
      expect(flat(out.systemPrompt)).toContain(
        'applies ONLY when you are about to call a comment/reaction/reply tool'
      );
      expect(out.systemPrompt).toContain('2. BRAND FIRST: ...');
    });

    it('is idempotent — a second pass changes nothing', () => {
      const once = rewritePublishGateScope(`x\n\n${ENG947_ERA_PUBLISH_GATE_BLOCK}\n`);
      const twice = rewritePublishGateScope(once.systemPrompt);
      expect(twice.systemPrompt).toBe(once.systemPrompt);
      expect(twice.applied).toEqual([]);
      expect(hasUnscopedPublishGateProse(twice.systemPrompt)).toBe(false);
    });
  });

  describe('drift guards', () => {
    it('every rewrite target is reachable from the live constants', () => {
      expect(MIN_PROMPTS.linkedInEngagement).toContain(
        PUBLISH_GATE_SCOPE_REWRITES.find((r) => r.key === 'linkedInEngagementRule')!.to
      );
      expect(PUBLISH_GATE_SCOPE_REWRITES.find((r) => r.key === 'publishGateBlock')!.to).toBe(
        BLOCKS.publishGate.text
      );
    });

    it('no rewrite is a no-op, and none reintroduces the ABSOLUTE/whole-session framing', () => {
      for (const r of PUBLISH_GATE_SCOPE_REWRITES) {
        expect(r.from).not.toBe(r.to);
        expect(flat(r.to)).not.toContain('overrides every other instruction');
        expect(flat(r.to)).not.toContain('overrides any other instruction here');
      }
    });

    it("the module's own frozen literals match the ENG-947-era text verbatim", () => {
      const from = (key: string) => PUBLISH_GATE_SCOPE_REWRITES.find((r) => r.key === key)!.from;
      expect(from('publishGateBlock')).toBe(ENG947_ERA_PUBLISH_GATE_BLOCK);
      expect(from('linkedInEngagementRule')).toBe(ENG947_ERA_LINKEDIN_ENGAGEMENT_RULE);
    });
  });
});
