/**
 * ENG-941 / ENG-926 §G — the destination fetch must look like a browser.
 *
 * This file previously sent `AgentWeb-TrackingPreflight/1.0`, which is exactly the mistake
 * its Google sibling documents avoiding: a custom bot UA is far more likely to be served a
 * WAF or bot-challenge page, which carries no tracking snippet, producing a false
 * `unmeasured` verdict on a landing page that is legitimately tracked.
 *
 * That matters twice over. This gate BLOCKS campaign launches on that verdict, so the bot UA
 * was costing real false blocks; and §G's daily sweep reuses the same fetcher, where the same
 * false reading would page a human every morning about a healthy page.
 *
 * Pinned here because the headers live inside an istanbul-ignored network boundary, where a
 * refactor could revert them with nothing failing.
 */

import { PREFLIGHT_FETCH_HEADERS } from '../services/metaTrackingPreflight';

describe('PREFLIGHT_FETCH_HEADERS', () => {
  it('presents a real browser user-agent, not a bot identifier', () => {
    const ua = PREFLIGHT_FETCH_HEADERS['User-Agent'];
    expect(ua).toContain('Mozilla/5.0');
    expect(ua).toMatch(/Chrome\/\d+/);
    expect(ua).not.toMatch(/AgentWeb|Preflight|bot|crawler/i);
  });

  it('sends the Accept headers a normal navigation would', () => {
    // A request advertising `Accept: */*` alone is another bot tell, and some WAFs key on it.
    expect(PREFLIGHT_FETCH_HEADERS['Accept']).toContain('text/html');
    expect(PREFLIGHT_FETCH_HEADERS['Accept-Language']).toBeTruthy();
  });
});
