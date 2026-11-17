/**
 * ENG-3134 — every Zoma tool response ends with one actionable next step, and nothing an agent
 * relays sends the user to the AgentWeb (Emma) app.
 *
 * Pure: no I/O. Applied at the MCP transport (routes/metaToolkit.ts) so every tool — Meta,
 * Google, Zoma — gets it without each handler re-implementing it. zoma_status already carries
 * its own next step (setup order), so it is passed through; the friend path ("just a friend")
 * gets nothing appended — its whole answer is the thank-you.
 */
import { ZOMA_NOT_INTERESTED_MESSAGE } from './zomaAdsExperience';

/** Shared Meta refusals (also used by the Emma app) name the Emma settings screen; Zoma users never see it. */
const EMMA_RECONNECT = /under Settings -> ?Connected accounts/g;
const ZOMA_RECONNECT = 'with a fresh Zoma connect link (call zoma_status)';

export function toZomaVoice(text: string): string {
  return text.replace(EMMA_RECONNECT, ZOMA_RECONNECT);
}

const SETUP_NEXT = 'Call zoma_status: it returns the exact fix (with a link if one is needed), then retry this call.';

/** Next step after a refused / failed call, from its message. */
export function zomaErrorNextStep(message: string): string {
  if (/Multiple (Meta ad accounts|Google Ads accounts)/i.test(message)) {
    return 'Ask the user which account to use, then retry with account_id (Meta) or customer_id (Google) set to it.';
  }
  if (/preview_token|PREVIEW/i.test(message)) {
    return 'Call again without confirm to get a fresh PREVIEW, show it to the user, and confirm only after they approve it.';
  }
  if (/payment method/i.test(message)) return 'Call zoma_status for the link to add a payment method (nothing is charged), then retry.';
  if (/read-only/i.test(message)) return 'Use a read tool here (e.g. zoma_ads_report), or make this change from Claude, ChatGPT, Codex or Cursor.';
  return SETUP_NEXT;
}

const isObject = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Next step after a successful call, or null when the response already carries its own. */
export function zomaNextStep(toolName: string, args: any, result: unknown): string | null {
  if (isObject(result)) {
    if (result.ads_experience === 'not_interested' || result.summary === ZOMA_NOT_INTERESTED_MESSAGE) return null;
    if (toolName === 'zoma_status') return null; // its summary/next_step is the setup order
    if (typeof result.next_step === 'string' && result.next_step) return null;
    if (result.success === false) return zomaErrorNextStep(String(result.message ?? result.error ?? ''));
    if (typeof result.preview_token === 'string') {
      return 'Show this preview to the user. Only after they approve it, repeat the exact same call with confirm=true and this preview_token.';
    }
    if (typeof result.verification === 'string') {
      return result.verification === 'CONFIRMED'
        ? 'Done and verified. Tell the user what changed; new campaigns, ad sets and ads stay PAUSED until they approve activation (its own preview).'
        : `The change was sent but not confirmed (${result.verification}). Re-read the object (GET) before retrying so nothing is duplicated.`;
    }
  }
  if (toolName === 'zoma_ads_report') {
    return 'Ask which campaign to dig into: rerun zoma_ads_report with campaign_ids and a different date range, or ask for a change (every change is previewed before it runs).';
  }
  if (toolName === 'zoma_usage') return 'Ask about results with zoma_ads_report, e.g. spend and ROAS by campaign for the last 7 days.';
  if (toolName === 'zoma_prepare_upload') return 'Run the upload_command with the real file path, then pass file_url to the creative upload call.';
  if (args?.confirm === true) return 'Read the object back (GET) to confirm the change, then tell the user what changed.';
  return 'Summarize this for the user, then offer the next useful question (e.g. "Which campaign had the best ROAS this week?" via zoma_ads_report) or a change — every change is previewed before it runs.';
}
