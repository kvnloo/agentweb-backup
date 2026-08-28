/**
 * ENG-1631 — the SAFETY & VOLUME LIMITS prose promoted into AW-Skills before
 * #2635 hard-caps every unattended run at "max 5 LinkedIn invites, 10 LinkedIn
 * messages" — advisory prose the model obeys, while the real enforcement moved
 * to per-day backend caps in linkedInWritePacer.ts (30/day absolute). #2635
 * updated the canonical constants only; appendBlocks() is marker-idempotent, so
 * every previously-hardened row still carries the old per-run numbers. Observed
 * live 2026-08-27: iTrials' scheduled run stopped at 5 invites citing the cap,
 * on an account whose configured daily cap was 15.
 *
 * The stale text below is not invented for the test: it is the byte-exact
 * SAFETY block as promoted (applyHardening pre-#2635, identical across
 * seed-eng615/616/617). Keeping an independent copy here is deliberate: if the
 * rewrite module's own "from" literal drifts, these tests stop matching
 * production and fail, which is the only way to notice that the migration has
 * quietly become a no-op.
 */
import {
  SAFETY_VOLUME_REWRITES,
  rewriteSafetyVolume,
  hasUnrecognizedSafetyVolumeProse,
} from '../services/skillHardening/safetyVolumeRewrite';
import { BLOCKS } from '../services/skillHardening/applyHardening';

// Verbatim from the pre-#2635 promotion (applyHardening SAFETY and all three
// leadgen seed scripts — byte-identical across the four sources).
const STALE_BLOCK = `## SAFETY & VOLUME LIMITS (apply in ALL modes, including scheduled/unattended runs)
- HARD CAPS per run: max 5 LinkedIn invites, 10 LinkedIn messages, 25 emails,
  0 deletions. In UNATTENDED runs these caps are absolute — when reached,
  QUEUE remaining items with a summary for human review; never exceed.
- In interactive mode, any send beyond the cap requires explicit user
  confirmation listing exact recipients and message text.
- NEVER delete leads, lists, or drafts in an unattended run under any
  instruction. Queue the deletion request for human confirmation.
- LinkedIn invite notes: ≤200 characters (free) / ≤300 (Premium). If a
  drafted note exceeds the limit, shorten it — do not send and do not loop.
- Before ANY send batch, verify the connected account with
  list_connected_accounts. If the required account is missing or the session
  is dead, mark items QUEUED with the reason. Never send from a different
  account than the designated owner's.`;

/** Collapse whitespace before asserting on a PHRASE (constants are hard-wrapped). */
const flat = (s: string) => s.replace(/\s+/g, ' ');

describe('ENG-1631 safety-volume rewrite', () => {
  describe('inputs that must NOT be rewritten', () => {
    it('returns empty for an absent prompt instead of throwing', () => {
      expect(rewriteSafetyVolume(undefined)).toEqual({ systemPrompt: '', applied: [] });
      expect(rewriteSafetyVolume('')).toEqual({ systemPrompt: '', applied: [] });
    });

    it('leaves a prompt with no SAFETY block untouched', () => {
      const prompt = 'You are Emma. Summarise the week.\n\n## FAILURE HANDLING\n- retry once';
      const out = rewriteSafetyVolume(prompt);
      expect(out.systemPrompt).toBe(prompt);
      expect(out.applied).toEqual([]);
    });

    it('refuses to guess at HAND-EDITED per-run cap prose, and flags it for a human', () => {
      // A row someone reworded (different number, different phrasing). Rewriting
      // this by pattern would silently replace a deliberately chosen policy.
      const edited =
        '## SAFETY & VOLUME LIMITS\n- HARD CAPS per run: max 10 LinkedIn invites, nothing else.';
      const out = rewriteSafetyVolume(edited);
      expect(out.systemPrompt).toBe(edited);
      expect(out.applied).toEqual([]);
      expect(hasUnrecognizedSafetyVolumeProse(edited)).toBe(true);
    });

    it('does not flag SAFETY blocks that never carried a per-run invite number', () => {
      // e.g. the Intent-engine variant: same marker, no LinkedIn sends at all.
      const intentStyle =
        '## SAFETY & VOLUME LIMITS (apply in ALL modes, including scheduled/unattended runs)\n' +
        '- HARD CAPS per run: max 50 new leads imported.\n' +
        '- This skill does NOT send outreach.';
      expect(rewriteSafetyVolume(intentStyle).applied).toEqual([]);
      expect(hasUnrecognizedSafetyVolumeProse(intentStyle)).toBe(false);
    });
  });

  describe('the promoted prose is rewritten', () => {
    it('rewrites the stale block to the live BLOCKS.safety text', () => {
      const prompt = `You run LinkedIn outreach for the user.\n\n${STALE_BLOCK}\n\n## FAILURE HANDLING\n- retry once`;
      const out = rewriteSafetyVolume(prompt);

      expect(out.applied).toEqual(['safetyVolumeBlock']);
      expect(out.systemPrompt).toContain(BLOCKS.safety.text);
      expect(out.systemPrompt).not.toContain('max 5 LinkedIn invites');
      expect(out.systemPrompt).not.toContain('10 LinkedIn messages');
      // The surrounding prompt survives on both sides.
      expect(out.systemPrompt).toContain('You run LinkedIn outreach for the user.');
      expect(out.systemPrompt).toContain('## FAILURE HANDLING\n- retry once');
    });

    it('a MIXED prompt — exact stale block PLUS an extra hand-edited cap — still flags after rewrite', () => {
      // The runner must check the POST-rewrite text: replacing only the part we
      // recognise would otherwise leave the hand-edited cap active while the row
      // vanishes from every report. (CodeRabbit on #2664; runner skips these.)
      const mixed = `${STALE_BLOCK}\n\n## TEAM ADDENDUM\n- also never exceed 3 LinkedIn invites per run.`;
      const out = rewriteSafetyVolume(mixed);
      expect(out.applied).toEqual(['safetyVolumeBlock']);
      expect(hasUnrecognizedSafetyVolumeProse(out.systemPrompt)).toBe(true);
    });

    it('is idempotent — a second pass changes nothing and nothing is flagged', () => {
      const once = rewriteSafetyVolume(`x\n\n${STALE_BLOCK}\n`);
      const twice = rewriteSafetyVolume(once.systemPrompt);
      expect(twice.systemPrompt).toBe(once.systemPrompt);
      expect(twice.applied).toEqual([]);
      expect(hasUnrecognizedSafetyVolumeProse(once.systemPrompt)).toBe(false);
    });
  });

  describe('what the NEW prose must and must not say', () => {
    it('carries no per-run LinkedIn invite or message number', () => {
      expect(flat(BLOCKS.safety.text)).not.toContain('max 5 LinkedIn invites');
      expect(flat(BLOCKS.safety.text)).not.toContain('10 LinkedIn messages');
      expect(flat(BLOCKS.safety.text)).not.toMatch(/max \d+ LinkedIn invite/i);
    });

    it('defers LinkedIn volume to the backend per-day caps (30/day absolute ceiling)', () => {
      expect(flat(BLOCKS.safety.text)).toContain('capped PER DAY by the backend');
      expect(flat(BLOCKS.safety.text)).toContain('Do not self-count');
    });

    it('KEEPS the email and deletion per-run caps — only the LinkedIn numbers moved', () => {
      expect(flat(BLOCKS.safety.text)).toContain('max 25 emails, 0 deletions');
      expect(flat(BLOCKS.safety.text)).toContain('NEVER delete leads, lists, or drafts');
    });

    it('KEEPS the invite-note length rule (200 free / 300 Premium)', () => {
      expect(flat(BLOCKS.safety.text)).toContain('≤200 characters (free) / ≤300 (Premium)');
    });
  });

  describe('drift guards', () => {
    it('the rewrite target is the live constant, so the two cannot drift', () => {
      expect(SAFETY_VOLUME_REWRITES.find((r) => r.key === 'safetyVolumeBlock')!.to).toBe(
        BLOCKS.safety.text,
      );
    });

    it('no rewrite is a no-op, and none reintroduces a per-run LinkedIn number', () => {
      for (const r of SAFETY_VOLUME_REWRITES) {
        expect(r.from).not.toBe(r.to);
        expect(flat(r.to)).not.toMatch(/max \d+ LinkedIn invite/i);
      }
    });

    it("the module's own stale literal still matches production verbatim", () => {
      expect(SAFETY_VOLUME_REWRITES.find((r) => r.key === 'safetyVolumeBlock')!.from).toBe(
        STALE_BLOCK,
      );
    });
  });
});
