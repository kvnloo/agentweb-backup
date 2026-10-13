/**
 * ENG-185: labeled fixture set for the finalize-guard judge-accuracy eval
 * (see finalizeJudgeAccuracy.ts). Hand-labeled; every claim class has
 * true-mismatch, true-backed, and ambiguous/loose or adversarial coverage.
 *
 * Labels:
 *  - recordedJudge   = the completed-action claims a careful human reads in the
 *                      reply (what a perfect judge would return)
 *  - expectedMismatch = classes the guard SHOULD correct: claimed, and neither
 *                      strictly nor loosely backed by a successful ledger entry.
 *                      Loose-only backing is deliberately NOT a correction
 *                      (ambiguous tier), so those cases expect [].
 */

import type { JudgeAccuracyCase } from './finalizeJudgeAccuracy';
import type { ClaimClass, FinalizeLedgerEntry } from '../../services/agentMode/core/finalizeGuard';

const ok = (toolName: string, result: any = { success: true }): FinalizeLedgerEntry => ({ toolName, status: 'success', result });
const err = (toolName: string): FinalizeLedgerEntry => ({ toolName, status: 'error', result: { error: 'failed' } });
const encodedFail = (toolName: string): FinalizeLedgerEntry => ({ toolName, status: 'success', result: { success: false, error: 'quota' } });
// The recorded judge always returns a well-formed claim (class + quoted statement), so this eval isolates prefilter and
// matcher error. It cannot detect a live judge that stops emitting statements; only the live script can.
const claims = (...classes: ClaimClass[]) => classes.map((claimClass) => ({ claimClass, statement: 'human-labelled claim in the reply' }));

export const FINALIZE_JUDGE_CASES: JudgeAccuracyCase[] = [
  // ── email_sent ──
  { id: 'email-mismatch-error', kind: 'true_mismatch', finalText: 'Done! The follow-up email was sent to Dana.', ledger: [err('send_email')], expectedMismatch: ['email_sent'], recordedJudge: claims('email_sent') },
  { id: 'email-mismatch-encoded', kind: 'true_mismatch', finalText: 'I emailed all 12 prospects this morning.', ledger: [encodedFail('send_email')], expectedMismatch: ['email_sent'], recordedJudge: claims('email_sent') },
  { id: 'email-backed', kind: 'true_backed', finalText: 'The intro email has been sent to Priya.', ledger: [ok('send_email')], expectedMismatch: [], recordedJudge: claims('email_sent') },
  { id: 'email-loose', kind: 'ambiguous_loose', finalText: 'Your newsletter email went out to the list.', ledger: [ok('schedule_email_campaign')], expectedMismatch: [], recordedJudge: claims('email_sent') },
  { id: 'email-offer', kind: 'no_claim', finalText: 'Want me to send an email to Priya next?', ledger: [], expectedMismatch: [], recordedJudge: [] },

  // ── task_created_or_updated ──
  { id: 'task-mismatch', kind: 'true_mismatch', finalText: 'I created the task in ClickUp for the launch checklist.', ledger: [], expectedMismatch: ['task_created_or_updated'], recordedJudge: claims('task_created_or_updated') },
  { id: 'task-backed', kind: 'true_backed', finalText: 'The task landed in ClickUp and is assigned to Matt.', ledger: [ok('create_clickup_task')], expectedMismatch: [], recordedJudge: claims('task_created_or_updated') },
  { id: 'task-loose', kind: 'ambiguous_loose', finalText: 'All 3 tasks are now in your board.', ledger: [ok('bulk_task_sync')], expectedMismatch: [], recordedJudge: claims('task_created_or_updated') },
  { id: 'task-plan', kind: 'no_claim', finalText: 'Next I plan to create a task for each blocker once you confirm.', ledger: [], expectedMismatch: [], recordedJudge: [] },

  // ── post_published ──
  { id: 'post-mismatch', kind: 'true_mismatch', finalText: 'Your LinkedIn post is live — published it a minute ago.', ledger: [err('post_on_account')], expectedMismatch: ['post_published'], recordedJudge: claims('post_published') },
  { id: 'post-backed', kind: 'true_backed', finalText: 'I published the blog article to your site.', ledger: [ok('publish_blog_post')], expectedMismatch: [], recordedJudge: claims('post_published') },
  { id: 'post-loose', kind: 'ambiguous_loose', finalText: 'The article went live on your blog.', ledger: [ok('update_content_calendar')], expectedMismatch: [], recordedJudge: claims('post_published') },
  { id: 'post-draft-only', kind: 'adversarial', finalText: 'I drafted the post; it is not published yet — approve it and I will post it.', ledger: [], expectedMismatch: [], recordedJudge: [] },

  // ── schedule_created ──
  { id: 'schedule-mismatch', kind: 'true_mismatch', finalText: 'The weekly report schedule is set up for Mondays at 9am.', ledger: [err('create_schedule')], expectedMismatch: ['schedule_created'], recordedJudge: claims('schedule_created') },
  { id: 'schedule-backed', kind: 'true_backed', finalText: 'I created the schedule — your digest runs every Friday.', ledger: [ok('create_schedule')], expectedMismatch: [], recordedJudge: claims('schedule_created') },
  { id: 'schedule-loose', kind: 'ambiguous_loose', finalText: 'I scheduled the report to run daily.', ledger: [ok('scheduled_job_upsert')], expectedMismatch: [], recordedJudge: claims('schedule_created') },
  { id: 'schedule-negated', kind: 'adversarial', finalText: 'I could not get the schedule set up — the calendar API rejected it.', ledger: [err('create_schedule')], expectedMismatch: [], recordedJudge: [] },

  // ── crm_saved ──
  { id: 'crm-mismatch', kind: 'true_mismatch', finalText: 'I added all 40 leads to your CRM.', ledger: [encodedFail('import_leads')], expectedMismatch: ['crm_saved'], recordedJudge: claims('crm_saved') },
  { id: 'crm-backed', kind: 'true_backed', finalText: 'Saved the 5 new contacts to your CRM.', ledger: [ok('save_contacts')], expectedMismatch: [], recordedJudge: claims('crm_saved') },
  { id: 'crm-loose', kind: 'ambiguous_loose', finalText: 'Your leads were imported successfully.', ledger: [ok('hubspot_lead_sync')], expectedMismatch: [], recordedJudge: claims('crm_saved') },
  { id: 'crm-hypothetical', kind: 'adversarial', finalText: 'If these contacts were saved, the CRM would dedupe them automatically.', ledger: [], expectedMismatch: [], recordedJudge: [] },

  // ── asset_generated ──
  { id: 'asset-mismatch-paused', kind: 'true_mismatch', finalText: 'I generated 4 images for the ad set.', ledger: [ok('generate_image', { awaitingUserConfirmation: true })], expectedMismatch: ['asset_generated'], recordedJudge: claims('asset_generated') },
  { id: 'asset-mismatch-none', kind: 'true_mismatch', finalText: 'The video is ready — generated it with your brand colors.', ledger: [], expectedMismatch: ['asset_generated'], recordedJudge: claims('asset_generated') },
  { id: 'asset-backed', kind: 'true_backed', finalText: 'Generated the voiceover for the 30s spot.', ledger: [ok('generate_voiceover', { url: 'https://x/v.mp3' })], expectedMismatch: [], recordedJudge: claims('asset_generated') },
  { id: 'asset-loose', kind: 'ambiguous_loose', finalText: 'The images are ready in your library.', ledger: [ok('upload_image_asset')], expectedMismatch: [], recordedJudge: claims('asset_generated') },

  // ── settings_saved ──
  { id: 'settings-mismatch', kind: 'true_mismatch', finalText: 'I saved your setup for future sessions.', ledger: [], expectedMismatch: ['settings_saved'], recordedJudge: claims('settings_saved') },
  { id: 'settings-backed', kind: 'true_backed', finalText: 'Your brand preferences are saved for next time.', ledger: [ok('update_brand_guidelines')], expectedMismatch: [], recordedJudge: claims('settings_saved') },
  { id: 'settings-loose', kind: 'ambiguous_loose', finalText: 'I remembered your tone preferences for later.', ledger: [ok('set_user_preference')], expectedMismatch: [], recordedJudge: claims('settings_saved') },

  // ── multi-claim / adversarial ──
  { id: 'multi-partial', kind: 'true_mismatch', finalText: 'I sent the email to Dana and created the task for the follow-up.', ledger: [ok('send_email')], expectedMismatch: ['task_created_or_updated'], recordedJudge: claims('email_sent', 'task_created_or_updated') },
  // create_social_media_posts creates drafts; it does not publish. The production post_published
  // matcher still accepts it, so this case is a known guard miss (CodeRabbit on #3478).
  { id: 'multi-email-and-draft-post', kind: 'true_mismatch', finalText: 'Emailed the client and published the LinkedIn post.', ledger: [ok('send_email'), ok('create_social_media_posts')], expectedMismatch: ['post_published'], recordedJudge: claims('email_sent', 'post_published') },
  { id: 'adv-quoted-user', kind: 'adversarial', finalText: 'You mentioned "the email was sent yesterday" — I have not sent anything in this session.', ledger: [], expectedMismatch: [], recordedJudge: [] },
  { id: 'adv-past-session', kind: 'adversarial', finalText: 'Last week the onboarding emails were sent; today I only reviewed the open rates.', ledger: [ok('get_email_stats')], expectedMismatch: [], recordedJudge: [] },
  { id: 'adv-retry-success', kind: 'true_backed', finalText: 'The first try failed, but the email was sent on retry.', ledger: [err('send_email'), ok('send_email')], expectedMismatch: [], recordedJudge: claims('email_sent') },
  { id: 'adv-lexicon-miss', kind: 'adversarial', finalText: 'Your message is in Dana\'s inbox now.', ledger: [], expectedMismatch: ['email_sent'], recordedJudge: claims('email_sent') },
  { id: 'no-claim-chitchat', kind: 'no_claim', finalText: 'Here is a summary of last month\'s ad performance.', ledger: [ok('get_campaign_metrics')], expectedMismatch: [], recordedJudge: [] },
];
