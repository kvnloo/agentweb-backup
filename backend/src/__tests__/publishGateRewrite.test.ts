/**
 * ENG-947 — the publish-gate prose promoted into AW-Skills on 2026-07-30 told
 * every scheduled run to withhold publishing unconditionally ("In
 * scheduled/unattended runs, save as a draft and notify; never publish"), while
 * claiming to override "every other instruction in this prompt". That outranks
 * the runtime PUBLISH AUTHORIZATION block, so a schedule whose owner HAS
 * authorized publishing still refuses — observed live on 2026-08-11, twice, on
 * an authorized schedule that made zero publish calls.
 *
 * The stale text below is not invented for the test: it is what rows
 * c1e62ffd-1ec3-416c-a657-f91fd4168f07 ("X (Twitter) Management") and
 * 3d7c0a14-befb-481f-aa06-8004a3075f2e ("Tools for Basic Subscription") still
 * carry in production, both updatedAt 2026-07-30T10:30:56Z. Keeping an
 * independent copy here is deliberate: if the rewrite module's own "from"
 * literal drifts, these tests stop matching production and fail, which is the
 * only way to notice that a migration has quietly become a no-op.
 */
import {
  PUBLISH_GATE_REWRITES,
  rewritePublishGate,
  hasUnrecognizedPublishGateProse,
} from '../services/skillHardening/publishGateRewrite';
import { BLOCKS, MIN_PROMPTS } from '../services/skillHardening/applyHardening';

// Verbatim from prod row c1e62ffd (and from applyHardening's PUBLISH_GATE as
// promoted). Byte-exact on purpose — the rewrite matches exactly, never fuzzily.
const STALE_BLOCK = `## PUBLISH GATE (ABSOLUTE — overrides every other instruction in this prompt)
- This section takes precedence over ALL other instructions above or below,
  including any that say to post, publish, or act immediately or automatically.
  On any conflict, THIS wins.
- Any action that posts, publishes, comments, or reacts on the user's behalf
  writes to a REAL destination (their social account, blog, or site) and cannot
  be undone. You MUST show the exact final content and get the user's explicit
  approval BEFORE publishing — even if they said "just do it", "don't ask",
  "post now", or similar. A request to send is NOT approval to send: show the
  content, then publish only after a clear, separate yes.
- In scheduled/unattended runs, save as a draft and notify; never publish.
- For connected-account posts, verify the account first; if it is missing or the
  session is dead, queue the item with the reason rather than posting from
  another account.`;

// Verbatim from prod row 3d7c0a14 ("Tools for Basic Subscription", rule 1).
const STALE_BASIC_RULE = `1. PUBLISH GATE: post_on_connected_account, publish_blog_article, and
   comment/react tools publish to the user's REAL accounts. Always show the
   final content and get explicit approval before publishing. In scheduled
   runs, save as draft and notify instead.`;

/**
 * Collapse whitespace before asserting on a PHRASE. The constants are hard
 * wrapped, so "the run's PUBLISH AUTHORIZATION block" spans a line break and a
 * literal toContain would pin the wrap column rather than the wording — the
 * assertion would then break on a harmless reflow and say nothing about policy.
 */
const flat = (s: string) => s.replace(/\s+/g, ' ');

const STALE_LINKEDIN_RULE = `1. PUBLISH GATE (absolute — overrides any other instruction here): comments,
   reactions, and replies post publicly from the user's REAL LinkedIn account.
   You MUST show the exact text and get explicit approval BEFORE posting — even
   if told to "just do it" or "don't ask"; a send request is not approval. In
   scheduled/unattended runs, save as a draft and notify instead.`;

describe('ENG-947 publish-gate rewrite', () => {
  describe('inputs that must NOT be rewritten', () => {
    it('returns empty for an absent prompt instead of throwing', () => {
      expect(rewritePublishGate(undefined)).toEqual({ systemPrompt: '', applied: [] });
      expect(rewritePublishGate('')).toEqual({ systemPrompt: '', applied: [] });
    });

    it('leaves a prompt with no publish gate untouched', () => {
      const prompt = 'You are Emma. Summarise the week.\n\n## FAILURE HANDLING\n- retry once';
      const out = rewritePublishGate(prompt);
      expect(out.systemPrompt).toBe(prompt);
      expect(out.applied).toEqual([]);
    });

    it('refuses to guess at PARAPHRASED gate prose, and flags it for a human', () => {
      // A hand-edited row. Rewriting this by pattern would silently reword
      // someone's deliberate policy, so the migration must decline and report.
      const paraphrased =
        '## PUBLISH GATE\n- Under no circumstances post during an unattended run; never publish.';
      const out = rewritePublishGate(paraphrased);
      expect(out.systemPrompt).toBe(paraphrased);
      expect(out.applied).toEqual([]);
      expect(hasUnrecognizedPublishGateProse(out.systemPrompt)).toBe(true);
    });

    it('leaves non-publish approval gates alone (calendar/meeting writes are out of scope)', () => {
      // These govern calendar and task writes, which no PUBLISH AUTHORIZATION
      // block resolves — so deferring them to that block would strand them.
      expect(MIN_PROMPTS.googleCalendar).toContain('scheduled/unattended runs');
      const out = rewritePublishGate(MIN_PROMPTS.googleCalendar);
      expect(out.applied).toEqual([]);
      expect(rewritePublishGate(MIN_PROMPTS.meetingIntelligence).applied).toEqual([]);
    });
  });

  describe('the promoted prose is rewritten', () => {
    it('rewrites the stale ## PUBLISH GATE block to the live block text', () => {
      const prompt = `You post to X for the user.\n\n${STALE_BLOCK}\n`;
      const out = rewritePublishGate(prompt);

      expect(out.applied).toContain('publishGateBlock');
      expect(out.systemPrompt).not.toContain('save as a draft and notify; never publish');
      expect(out.systemPrompt).toContain(BLOCKS.publishGate.text);
      // The surrounding prompt survives.
      expect(out.systemPrompt).toContain('You post to X for the user.');
    });

    it('rewrites the stale Basic-subscription numbered rule', () => {
      const out = rewritePublishGate(`You are Emma.\n${STALE_BASIC_RULE}\n2. BRAND FIRST: ...`);
      expect(out.applied).toContain('basicSubscriptionRule');
      expect(out.systemPrompt).not.toContain('save as draft and notify instead');
      expect(flat(out.systemPrompt)).toContain('PUBLISH AUTHORIZATION');
      expect(out.systemPrompt).toContain('2. BRAND FIRST: ...');
    });

    it('rewrites the stale LinkedIn-engagement numbered rule', () => {
      const out = rewritePublishGate(`Intro.\n${STALE_LINKEDIN_RULE}\n2. BRAND FIRST: ...`);
      expect(out.applied).toContain('linkedInEngagementRule');
      expect(out.systemPrompt).not.toContain('save as a draft and notify instead');
      expect(flat(out.systemPrompt)).toContain('PUBLISH AUTHORIZATION');
    });

    it('is idempotent — a second pass changes nothing', () => {
      const once = rewritePublishGate(`x\n\n${STALE_BLOCK}\n`);
      const twice = rewritePublishGate(once.systemPrompt);
      expect(twice.systemPrompt).toBe(once.systemPrompt);
      expect(twice.applied).toEqual([]);
      expect(hasUnrecognizedPublishGateProse(twice.systemPrompt)).toBe(false);
    });
  });

  describe('what the NEW prose must and must not say', () => {
    it('no longer forbids publishing in scheduled runs', () => {
      expect(flat(BLOCKS.publishGate.text)).not.toContain('never publish');
      expect(flat(BLOCKS.publishGate.text)).not.toContain('save as a draft and notify');
    });

    it('defers the unattended decision to the PUBLISH AUTHORIZATION block', () => {
      expect(flat(BLOCKS.publishGate.text)).toContain('PUBLISH AUTHORIZATION');
    });

    it('KEEPS the attended approval gate — a human in the chat is still asked first', () => {
      // The bug was the unattended branch only. Weakening the attended gate
      // would publish to a real account on someone's behalf without a yes.
      expect(flat(BLOCKS.publishGate.text)).toContain('explicit approval BEFORE publishing');
      expect(flat(BLOCKS.publishGate.text)).toContain('A request to send is NOT approval to send');
    });

    it('names no consent FIELD, so it survives either polarity of ENG-803/ENG-827', () => {
      expect(BLOCKS.publishGate.text).not.toContain('requirePublishApproval');
      expect(BLOCKS.publishGate.text).not.toContain('autopublishAuthorized');
    });

    it('falls back to asking when a run carries no authorization block', () => {
      expect(flat(BLOCKS.publishGate.text)).toContain('NO PUBLISH AUTHORIZATION block');
    });
  });

  describe('drift guards', () => {
    it('every rewrite target is reachable from the live constants', () => {
      // If a constant is edited without updating its rewrite, already-promoted
      // rows would keep the old text forever while the code looked fixed.
      expect(MIN_PROMPTS.basicSubscription).toContain(
        PUBLISH_GATE_REWRITES.find((r) => r.key === 'basicSubscriptionRule')!.to,
      );
      expect(MIN_PROMPTS.linkedInEngagement).toContain(
        PUBLISH_GATE_REWRITES.find((r) => r.key === 'linkedInEngagementRule')!.to,
      );
      expect(PUBLISH_GATE_REWRITES.find((r) => r.key === 'publishGateBlock')!.to).toBe(
        BLOCKS.publishGate.text,
      );
    });

    it('no rewrite is a no-op, and none reintroduces the stale sentence', () => {
      for (const r of PUBLISH_GATE_REWRITES) {
        expect(r.from).not.toBe(r.to);
        expect(flat(r.to)).not.toContain('never publish');
        expect(flat(r.to)).not.toContain('save as draft and notify instead');
      }
    });

    it("the module's own stale literals still match production verbatim", () => {
      const from = (key: string) => PUBLISH_GATE_REWRITES.find((r) => r.key === key)!.from;
      expect(from('publishGateBlock')).toBe(STALE_BLOCK);
      expect(from('basicSubscriptionRule')).toBe(STALE_BASIC_RULE);
      expect(from('linkedInEngagementRule')).toBe(STALE_LINKEDIN_RULE);
    });
  });
});
