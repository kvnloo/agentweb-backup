// ENG-1715: SEND_TOOLS fall between the two existing press breakers — not
// isPublishName (ENG-947), not isReadOnlyToolName (ENG-1297) — so a scheduled run
// that cannot satisfy a send requirement took the full 20-attempt press with no
// breaker at all, arguing directly against the tool's own "DO NOT keep trying
// other recipients" guidance.

import {
  MAX_SEND_PRESS_ATTEMPTS,
  isSendOnlyUnmet,
  shouldStopPressingForSend,
} from '../utils/sendPressCircuitBreaker';
import { SEND_TOOLS, isSendName, isPublishName } from '../utils/hardeningGaps';
import { isReadOnlyToolName } from '../utils/toolWriteClassification';
import { isPublishOnlyUnmet } from '../utils/publishPressCircuitBreaker';
import { isReadOnlyOnlyUnmet } from '../utils/readOnlyPressCircuitBreaker';

describe('isSendOnlyUnmet', () => {
  it('fires for the SEND_TOOLS entries that had no breaker at all', () => {
    // The gap is not LinkedIn-specific; each of these fell through both existing
    // breakers identically. send_email_from_sender and twitter_manage_post are
    // excluded — the publish breaker already owns them (see AC #4 below).
    ['linkedin_outreach', 'send_email', 'send_email_to_lead', 'linkedin_manage_post',
      'twitter_outreach', 'delete_leads', 'delete_leads_by_filter', 'delete_lead_list',
      'enrich_leads_execute', 'import_leads_from_search'].forEach((name) => {
      expect(SEND_TOOLS.has(name)).toBe(true);
      expect(isSendOnlyUnmet([name])).toBe(true);
    });
    expect(isSendOnlyUnmet(['linkedin_outreach', 'send_email'])).toBe(true);
  });

  it('fires for the prefix families isSendName catches, not just the explicit set', () => {
    ['send_email_blast', 'acme_outreach', 'acme_manage_post'].forEach((name) => {
      expect(isSendName(name)).toBe(true);
      expect(isSendOnlyUnmet([name])).toBe(true);
    });
  });

  it('does NOT fire on a mixed set — the breaker is for the ONLY thing left (AC #3)', () => {
    expect(isSendOnlyUnmet(['linkedin_outreach', 'you_search_web'])).toBe(false);
    expect(isSendOnlyUnmet(['linkedin_outreach', 'post_on_connected_account'])).toBe(false);
    expect(isSendOnlyUnmet(['linkedin_outreach', 'generate_image'])).toBe(false);
  });

  it('AC #4: a name the publish breaker claims is left to it, never claimed here', () => {
    expect(isSendOnlyUnmet(['post_on_connected_account'])).toBe(false);
    expect(isSendOnlyUnmet(['publish_blog_article'])).toBe(false);

    // The ticket's AC #4 says a tool that is both publish and send is "none
    // today". That is wrong, and it matters: send_email_from_sender and
    // twitter_manage_post are BOTH isSendName and already claimed by the publish
    // breaker — through EQUIVALENT_PUBLISH_ROUTES (ENG-1599), not isPublishName.
    // Excluding only isPublishName here would have let both breakers claim the
    // same turn and cut a publish stall short at this smaller budget.
    ['send_email_from_sender', 'twitter_manage_post'].forEach((name) => {
      expect(isSendName(name)).toBe(true);
      expect(isPublishName(name)).toBe(false);
      expect(isPublishOnlyUnmet([name])).toBe(true);
      expect(isSendOnlyUnmet([name])).toBe(false);
    });

    // A name that is publish by PREFIX and send by suffix resolves to publish too.
    const both = 'post_on_x_outreach';
    expect(isPublishName(both) && isSendName(both)).toBe(true);
    expect(isSendOnlyUnmet([both])).toBe(false);
  });

  it('fails safe on an empty or malformed set, matching both siblings', () => {
    expect(isSendOnlyUnmet([])).toBe(false);
    expect(isSendOnlyUnmet(null as any)).toBe(false);
    expect(isSendOnlyUnmet(undefined as any)).toBe(false);
    expect(isSendOnlyUnmet('linkedin_outreach' as any)).toBe(false);
    expect(isSendOnlyUnmet([null as any])).toBe(false);
    expect(isSendOnlyUnmet(['linkedin_outreach', 42 as any])).toBe(false);
  });

  it('does not claim send_for_review, which only looks like a send', () => {
    expect(isSendOnlyUnmet(['send_for_review'])).toBe(false);
  });
});

describe('shouldStopPressingForSend', () => {
  it('stops at the budget and not before (AC #1)', () => {
    const unmet = ['linkedin_outreach'];
    expect(MAX_SEND_PRESS_ATTEMPTS).toBe(2);
    expect(shouldStopPressingForSend({ pressAttempt: 1, unmetRequiredFunctions: unmet })).toBe(false);
    expect(shouldStopPressingForSend({ pressAttempt: 2, unmetRequiredFunctions: unmet })).toBe(true);
    expect(shouldStopPressingForSend({ pressAttempt: 3, unmetRequiredFunctions: unmet })).toBe(true);
  });

  it('never fires while anything non-send is still outstanding, at any press count', () => {
    [1, 2, 5, 20].forEach((pressAttempt) => {
      expect(shouldStopPressingForSend({
        pressAttempt,
        unmetRequiredFunctions: ['linkedin_outreach', 'you_search_web'],
      })).toBe(false);
    });
  });

  it('honours a caller-supplied budget override', () => {
    const unmet = ['send_email'];
    expect(shouldStopPressingForSend({ pressAttempt: 2, unmetRequiredFunctions: unmet, maxPressAttempts: 3 })).toBe(false);
    expect(shouldStopPressingForSend({ pressAttempt: 3, unmetRequiredFunctions: unmet, maxPressAttempts: 3 })).toBe(true);
  });
});

describe('breaker classes stay mutually exclusive (drift guard)', () => {
  // The controller checks send BEFORE read-only precisely so a future classifier
  // change cannot let a send be WAIVED as read-only. This pins the assumption that
  // ordering currently guards nothing live.
  it('no SEND_TOOLS entry is classified read-only or publish-by-name', () => {
    [...SEND_TOOLS].forEach((name) => {
      expect(isReadOnlyToolName(name)).toBe(false);
      expect(isPublishName(name)).toBe(false);
    });
  });

  it('every SEND_TOOLS entry is claimed by exactly one of the three breakers', () => {
    // The two the publish breaker already owns are listed explicitly rather than
    // filtered out silently, so growing EQUIVALENT_PUBLISH_ROUTES fails this test
    // and forces a deliberate decision about which breaker takes the new name.
    const OWNED_BY_PUBLISH = new Set(['send_email_from_sender', 'twitter_manage_post']);
    [...SEND_TOOLS].forEach((name) => {
      const publishClaims = OWNED_BY_PUBLISH.has(name);
      expect(isPublishOnlyUnmet([name])).toBe(publishClaims);
      expect(isSendOnlyUnmet([name])).toBe(!publishClaims);
      expect(isReadOnlyOnlyUnmet([name])).toBe(false);
    });
  });

  it('AC #4: publish-only and read-only sets are untouched by the new breaker', () => {
    ['post_on_connected_account', 'publish_blog_article'].forEach((name) => {
      expect(isPublishOnlyUnmet([name])).toBe(true);
      expect(isSendOnlyUnmet([name])).toBe(false);
    });
    ['you_search_web', 'get_marketing_tips', 'perform_data_analysis'].forEach((name) => {
      expect(isReadOnlyOnlyUnmet([name])).toBe(true);
      expect(isSendOnlyUnmet([name])).toBe(false);
    });
  });
});
