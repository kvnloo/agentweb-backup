// Transactional delivery of the AI Marketing Readiness Roadmap.
//
// WORKAROUND (2026-06-04): The proper path for this is a list-bound drip
// sequence (step 1 = delivery email). That path is not usable right now:
//   - the CRM drip "sequence feature is not yet ready for use" (Rui, 2026-06-04)
//   - the public forward-lead webhook does not auto-enroll captured leads into
//     list-bound sequences (bug AGW-37509247-c951-8108-9545-fb47c0914bdc)
// So we send the magnet delivery email directly from the forward-lead webhook
// via resendService.sendSystemEmail. When the sequence system is production
// ready, this should be replaced by step 1 of the per-stage sequence and the
// leads re-synced into it. Flagged to Rui.

import { resendService } from './resendService';

type StageMeta = { name: string; teach: string };

const STAGES: Record<number, StageMeta> = {
  1: {
    name: 'Denial',
    teach:
      'Most teams here tried AI once, it wrote bad copy, and they wrote it off. The roadmap shows you what good actually looks like, and the one thing to try next.',
  },
  2: {
    name: 'The Sandbox',
    teach:
      'You use AI to brainstorm, but the real work still happens by hand. The roadmap shows you the first task worth automating, and how to start.',
  },
  3: {
    name: 'The Chatbot Ceiling',
    teach:
      'You use AI every day, but you are the one moving the work by hand. Copy the brief in, copy the output out, paste it everywhere. The roadmap shows you the move that breaks that ceiling.',
  },
  4: {
    name: 'The Engineering Trap',
    teach:
      'You built agents, but they break every week and you spend more time fixing them than shipping. The roadmap shows you how to make them hold without a full engineering team.',
  },
  5: {
    name: 'Production',
    teach:
      'One agent runs in production, but it still hallucinates and you cannot fully trust it yet. The roadmap shows you the evals and guardrails that earn that trust.',
  },
  6: {
    name: 'Orchestration',
    teach:
      'You are running a whole agent team now. The hard part is keeping them coordinated and learning from each other. The roadmap shows you how the best teams run the orchestra.',
  },
};

const BASE_URL = process.env.ROADMAP_BASE_URL || 'https://www.agentweb.pro';
const BOOK_URL =
  'https://hireemma.ai/book?utm_source=ai_readiness&utm_medium=email&utm_campaign=roadmap_delivery';

function buildEmail(stage: number, firstName?: string): { subject: string; html: string } {
  const meta = STAGES[stage];
  const hi = firstName ? `Hi ${firstName},` : 'Hi,';
  const pdfUrl = `${BASE_URL}/roadmap/Stage${stage}.pdf`;
  const subject = `Your AI Marketing Readiness Roadmap (Stage ${stage})`;

  const html = `
  <div style="font-family:Inter,Arial,sans-serif;font-size:16px;line-height:1.55;color:#1B2549;max-width:560px">
    <p>${hi}</p>
    <p>As promised, here is your AI Marketing Readiness Roadmap.</p>
    <p><strong><a href="${pdfUrl}" style="color:#5b3df5">Open your Stage ${stage} roadmap (PDF)</a></strong></p>
    <p>Inside you will find:</p>
    <ul>
      <li>What Stage ${stage} really is, and the ceiling you are hitting</li>
      <li>The one constraint that is capping your output right now</li>
      <li>The single move that gets you to the next stage</li>
    </ul>
    <p>Your quiz answers put you at <strong>Stage ${stage}: ${meta.name}</strong>.</p>
    <p>${meta.teach}</p>
    <p>Talk soon,<br>Harsha</p>
    <p style="color:#888;font-size:13px;margin-top:22px">
      P.S. Want a second set of eyes on your stack?
      <a href="${BOOK_URL}&utm_content=stage${stage}" style="color:#6457F6">Book a free 30-minute stack review.</a>
      No pitch. We tell you honestly whether to build, buy, or wait.
    </p>
  </div>`.trim();

  return { subject, html };
}

/**
 * Send the roadmap delivery email if the lead came from the AI Readiness funnel
 * and carries a valid stage (1-6). Fire-and-forget: never throws. Returns true
 * if a send was attempted.
 */
export async function sendRoadmapDeliveryEmail(args: {
  to: string;
  stage: unknown;
  source?: unknown;
  firstName?: string;
}): Promise<boolean> {
  try {
    const source = String(args.source ?? '').toLowerCase();
    // Gate: only the AI Readiness roadmap funnel. Other lists may carry a stray
    // "stage" custom field, so require the source to opt in explicitly.
    if (!source.includes('ai-readiness') && !source.includes('ai_readiness') && !source.includes('readiness-roadmap')) {
      return false;
    }
    const stage = Number(args.stage);
    if (!Number.isInteger(stage) || stage < 1 || stage > 6) return false;
    if (!args.to) return false;

    const { subject, html } = buildEmail(stage, args.firstName);
    await resendService.sendSystemEmail({ to: args.to, subject, html });
    console.log(`[roadmapDelivery] sent Stage ${stage} roadmap to ${args.to}`);
    return true;
  } catch (err) {
    console.error('[roadmapDelivery] send failed:', err);
    return false;
  }
}
