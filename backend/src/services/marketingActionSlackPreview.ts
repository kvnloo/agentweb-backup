/**
 * Condensed Slack rendering of the shared top-three marketing actions (ENG-573).
 *
 * Thin adapter over the ENG-445/446 contract: it reads the canonical action
 * payload off a report/run envelope through the ONE shared parser
 * (`readMarketingActions`) and renders it verbatim — same ids, same stored
 * order, same statuses. There is deliberately no ranking, filtering, or
 * recommendation logic here; a Slack surface that disagrees with the portal is
 * a contract violation, not a feature.
 *
 * Degraded states are explicit values, not exceptions: a legacy/actionless
 * envelope reads as `empty` (send nothing), and a tampered or structurally
 * invalid payload reads as `invalid` with the parser's reason (send nothing,
 * caller logs). A broken payload must never surface as a fabricated preview,
 * and a Slack hiccup must never fail the producing run.
 */
import { MarketingAction, MarketingActionContractError } from './marketingActionContract';
import { readMarketingActions } from './marketingActionEnvelope';
import { postSlackMessage } from './slackService';

export interface MarketingActionSlackPreviewOptions {
  /** Base URL portal-relative deepLinks are joined onto. */
  portalBaseUrl?: string;
}

export type MarketingActionSlackPreview =
  | { kind: 'preview'; text: string; actionIds: string[] }
  | { kind: 'empty' }
  | { kind: 'invalid'; reason: string };

export type MarketingActionSlackSendOutcome =
  | { kind: 'sent'; ts: string; channel: string }
  | { kind: 'empty' }
  | { kind: 'invalid'; reason: string };

/** Read at call time (not module load) so tests and env changes both apply. */
export function defaultPortalBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.CUSTOMER_FRONTEND_URL || 'https://app.agentweb.pro';
}

const STATUS_MARKER: Record<MarketingAction['status'], string> = {
  proposed: '🔹',
  approved: '✅',
  dismissed: '🚫',
  completed: '✔️',
};

/** Recommendations originate from report/run content — escape Slack's control
 *  characters so text can't smuggle broadcasts or disguised links (same rule
 *  as shipNotifyService). */
const escapeSlackText = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Absolute http(s) deepLinks pass through; portal paths join the portal base. */
function resolveDeepLink(deepLink: string, portalBaseUrl: string): string {
  if (/^https?:\/\//.test(deepLink)) return deepLink;
  const base = portalBaseUrl.replace(/\/+$/, '');
  const path = deepLink.startsWith('/') ? deepLink : `/${deepLink}`;
  return `${base}${path}`;
}

/**
 * Build the condensed Slack representation of the actions an envelope carries.
 * Pure apart from the env-derived default portal base; performs no I/O.
 */
export function buildMarketingActionSlackPreview(
  envelope: unknown,
  options: MarketingActionSlackPreviewOptions = {}
): MarketingActionSlackPreview {
  let actions: MarketingAction[];
  try {
    actions = readMarketingActions(envelope);
  } catch (err) {
    if (err instanceof MarketingActionContractError) {
      return { kind: 'invalid', reason: err.message };
    }
    throw err;
  }
  if (actions.length === 0) return { kind: 'empty' };

  const portalBaseUrl = options.portalBaseUrl || defaultPortalBaseUrl();

  const lines = actions.map((action, index) => {
    const url = resolveDeepLink(action.deepLink, portalBaseUrl);
    return (
      `${index + 1}. ${STATUS_MARKER[action.status]} *${escapeSlackText(action.recommendation)}*` +
      ` — ${escapeSlackText(action.expectedImpact)}` +
      `\n    status: ${action.status} · id: \`${action.id}\` · <${url}|View in portal>`
    );
  });

  return {
    kind: 'preview',
    text: `*Top ${actions.length === 1 ? 'move' : `${actions.length} moves`} today*\n${lines.join('\n')}`,
    actionIds: actions.map((a) => a.id),
  };
}

/**
 * Post the preview to a Slack channel. Sends exactly one message for a
 * non-empty valid payload; sends nothing (and says so) for empty or invalid
 * envelopes. Transport only — building is fully delegated above.
 */
export async function sendMarketingActionsSlackPreview(
  channelId: string,
  envelope: unknown,
  options: MarketingActionSlackPreviewOptions = {}
): Promise<MarketingActionSlackSendOutcome> {
  const preview = buildMarketingActionSlackPreview(envelope, options);
  if (preview.kind !== 'preview') return preview;

  const { ts, channel } = await postSlackMessage(channelId, preview.text);
  return { kind: 'sent', ts, channel };
}
