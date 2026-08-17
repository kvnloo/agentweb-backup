/**
 * Unit tests for the PURE final-synthesis residue guard (ENG-1054).
 *
 * The production failure this pins: a 215-message session whose closing assistant
 * message was the literal string "}]" — serialization residue, not an answer. The
 * loop shipped it because its only "failed synthesis" check was `!content`.
 */

import {
  isUnusableSynthesis,
  buildExecutedActionsFallback,
  buildExecutedActionsFooter,
} from '../synthesisResidue';
import { SYNTHESIS_NUDGE, CONTINUE_PROMPT, ANTI_LOOP_STOP_MESSAGE } from '../termination';
import { buildTurnTimeBudgetNudge, type TurnTimeBudgetState } from '../../../../utils/turnTimeBudget';

function timeBudgetState(remainingSeconds: number): TurnTimeBudgetState {
  return { phase: 'wrap_up', elapsedMs: 0, remainingMs: remainingSeconds * 1000, reserveMs: 0 };
}

describe('isUnusableSynthesis', () => {
  it('flags the exact production residue "}]"', () => {
    expect(isUnusableSynthesis('}]')).toBe(true);
  });

  it('flags other structural-punctuation-only remnants', () => {
    for (const residue of ['}', ']', '}}', '"}]', '},{', '  }]\n', '{"', ':', '",']) {
      expect(isUnusableSynthesis(residue)).toBe(true);
    }
  });

  // Greptile P1: punctuation-only is not the same as unusable. A COMPLETE value is
  // a legitimate answer to "return an empty object" or "show me the list", and
  // discarding it would replace the user's answer with the synthesis-failure recap.
  // Residue never parses; a complete value always does.
  it('does NOT flag short but COMPLETE JSON values', () => {
    for (const valid of ['{}', '[]', '[{}]', '{ }', '[ ]', '[{},{}]', '""', '[""]']) {
      expect(isUnusableSynthesis(valid)).toBe(false);
    }
  });

  it('does NOT flag empty/whitespace content (the existing empty-synthesis ladder owns that)', () => {
    for (const empty of ['', '   ', '\n\t']) {
      expect(isUnusableSynthesis(empty)).toBe(false);
    }
  });

  it('does NOT flag short but genuine answers', () => {
    for (const real of ['Yes.', 'Done', 'OK', '42', 'Paused both campaigns.', '✅', '...', '—']) {
      expect(isUnusableSynthesis(real)).toBe(false);
    }
  });

  it('does NOT flag a long response that merely ends in structural punctuation', () => {
    expect(isUnusableSynthesis('I paused both campaigns. Here is the JSON I used: {"status":"PAUSED"}')).toBe(false);
  });

  // Message 163 of the production session: the model transcribed the preceding
  // tool result back as its own answer — 20,081 chars opening with the loop's own
  // degraded-history marker. Too long for the punctuation rule, same failure.
  it('flags a reply that echoes the loop\'s degraded tool history', () => {
    const echo =
      '[Result of call_meta_marketing_api: {"success":true,"message":"Found 25 ad(s)","ads":['
      + '{"id":"120248669405960585","name":"P3 A1"}'.repeat(200)
      + '\n\n[Content truncated — full response in S3]}}';
    expect(echo.length).toBeGreaterThan(1000);
    expect(isUnusableSynthesis(echo)).toBe(true);
  });

  it('flags a reply that opens with the degraded tool-call marker', () => {
    expect(isUnusableSynthesis('[Previously called call_meta_marketing_api({"action":"UPDATE"})]')).toBe(true);
  });

  // Observed live: driving the synthesis retry into a failure state made the model
  // collapse into a repetition loop and ship 180,180 chars — 30,791 words built
  // from 65 unique tokens — straight into the transcript.
  it('flags a degenerate repetition collapse', () => {
    const collapse = 'If you need to output a code block ensure it is properly enclosed. '
      + 'group '.repeat(20000);
    expect(collapse.length).toBeGreaterThan(100_000);
    expect(isUnusableSynthesis(collapse)).toBe(true);
  });

  it('does NOT flag long genuine prose with a normal vocabulary', () => {
    // ~600 words of varied text — the shape the guard must never touch.
    const words: string[] = [];
    for (let i = 0; i < 600; i++) words.push(`campaign${i} spend${i} result${i}`.split(' ')[i % 3]);
    const prose = words.join(' ');
    expect(prose.split(/\s+/).length).toBeGreaterThan(300);
    expect(isUnusableSynthesis(prose)).toBe(false);
  });

  it('does NOT flag a long but legitimately repetitive status list', () => {
    // A real answer can repeat heavily — 10-15% unique is normal for a table.
    const rows: string[] = [];
    for (let i = 0; i < 400; i++) rows.push(`- Campaign ${i} status PAUSED budget 3000 daily`);
    expect(isUnusableSynthesis(rows.join('\n'))).toBe(false);
  });

  it('does NOT flag a short repetitive answer below the word floor', () => {
    expect(isUnusableSynthesis('yes '.repeat(50))).toBe(false);
  });

  // ENG-1188: a 101-message gemini-3.1-pro-preview work-plan session generated and
  // screenshot-verified the corrected ad assets, then closed with the model echoing
  // the injected synthesis nudge back verbatim instead of writing the delivery
  // message — three repeats in 744 chars, well under isDegenerateRepetition's
  // 1000-char/300-word floor, so the real answer never reached the user even though
  // the guard built for exactly this failure class (ENG-1054/946) was already live.
  it('flags a reply that echoes the injected synthesis nudge back verbatim', () => {
    const echo = `${SYNTHESIS_NUDGE} ${SYNTHESIS_NUDGE} ${SYNTHESIS_NUDGE}`;
    expect(echo.length).toBeLessThan(1000);
    expect(isUnusableSynthesis(echo)).toBe(true);
  });

  // ENG-1188 follow-up: a terminating turn whose ENTIRE content is exactly one bare
  // copy of the nudge is non-empty, so it never re-triggers the empty-synthesis
  // retry ladder in termination.ts either — it must be caught here.
  it('flags a reply that is exactly one bare copy of the nudge', () => {
    expect(isUnusableSynthesis(SYNTHESIS_NUDGE)).toBe(true);
  });

  // Pins the exact >= 2 cutoff used by isNudgeEcho, distinct from the 3-repeat and
  // exact-single-copy cases already covered above.
  it('flags exactly two verbatim copies of the nudge (the boundary)', () => {
    expect(isUnusableSynthesis(`${SYNTHESIS_NUDGE} ${SYNTHESIS_NUDGE}`)).toBe(true);
  });

  it('does NOT flag a single quoted mention of the nudge text', () => {
    expect(
      isUnusableSynthesis(`I saw the system message "${SYNTHESIS_NUDGE}" and then finished the export.`)
    ).toBe(false);
  });

  // ENG-1188 follow-up: `isUnusableSynthesis` is the single choke point for every
  // terminating turn (agentModeService.ts calls it once, on whatever content is
  // about to ship), and CONTINUE_PROMPT / ANTI_LOOP_STOP_MESSAGE are injected by the
  // exact same "push a system nudge, let the model respond again" mechanism as
  // SYNTHESIS_NUDGE — a max_tokens continuation and a same-tool-calls anti-loop
  // warning. A model that echoes either of THOSE back instead of answering is just
  // as unrecoverable and just as unguarded before this, since only SYNTHESIS_NUDGE
  // was recognized.
  it('flags a reply that echoes the continuation nudge back verbatim', () => {
    expect(isUnusableSynthesis(`${CONTINUE_PROMPT} ${CONTINUE_PROMPT}`)).toBe(true);
  });

  it('flags a reply that is exactly one bare copy of the continuation nudge', () => {
    expect(isUnusableSynthesis(CONTINUE_PROMPT)).toBe(true);
  });

  it('flags a reply that echoes the anti-loop STOP message back verbatim', () => {
    expect(isUnusableSynthesis(`${ANTI_LOOP_STOP_MESSAGE} ${ANTI_LOOP_STOP_MESSAGE}`)).toBe(true);
  });

  it('flags a reply that is exactly one bare copy of the anti-loop STOP message', () => {
    expect(isUnusableSynthesis(ANTI_LOOP_STOP_MESSAGE)).toBe(true);
  });

  it('does NOT flag a single quoted mention of the continuation or anti-loop nudges', () => {
    expect(
      isUnusableSynthesis(`I saw the system message "${CONTINUE_PROMPT}" and then finished the export.`)
    ).toBe(false);
    expect(
      isUnusableSynthesis(`I saw the system message "${ANTI_LOOP_STOP_MESSAGE}" and then finished the export.`)
    ).toBe(false);
  });

  // ENG-1188 follow-up: ENG-907's wall-clock nudges (buildTurnTimeBudgetNudge) are
  // injected by the same mechanism as the fixed-string nudges above, but each embeds
  // a live remaining-seconds count, so no injection is byte-identical to another —
  // an exact-string check would never match. A bare echo (or repeat) of either phase
  // is just as unrecoverable a failure as the fixed-string nudges.
  it('flags a reply that is exactly one bare copy of the wrap_up time-budget nudge', () => {
    const nudge = buildTurnTimeBudgetNudge(timeBudgetState(42), 'wrap_up');
    expect(isUnusableSynthesis(nudge)).toBe(true);
  });

  it('flags a reply that is exactly one bare copy of the final_synthesis time-budget nudge', () => {
    const nudge = buildTurnTimeBudgetNudge(timeBudgetState(17), 'final_synthesis');
    expect(isUnusableSynthesis(nudge)).toBe(true);
  });

  it('flags a reply that echoes the time-budget nudge twice, even with drifting seconds counts', () => {
    const first = buildTurnTimeBudgetNudge(timeBudgetState(42), 'final_synthesis');
    const second = buildTurnTimeBudgetNudge(timeBudgetState(41), 'final_synthesis');
    expect(isUnusableSynthesis(`${first} ${second}`)).toBe(true);
  });

  it('does NOT flag a single quoted mention of the time-budget nudge', () => {
    const nudge = buildTurnTimeBudgetNudge(timeBudgetState(42), 'wrap_up');
    expect(isUnusableSynthesis(`I saw the system message "${nudge}" and then finished the export.`)).toBe(false);
  });

  it('does NOT flag prose that merely mentions a tool result', () => {
    for (const real of [
      'The result of call_meta_marketing_api was a success — both campaigns are paused.',
      'Here is what I found. [Result data is summarized below.]',
      '[Note] I previously called the Meta API to pause both campaigns.',
    ]) {
      expect(isUnusableSynthesis(real)).toBe(false);
    }
  });

  it('does NOT flag a large brace blob (only short remnants are residue)', () => {
    expect(isUnusableSynthesis('}'.repeat(200))).toBe(false);
  });

  it('is defensive about non-string input', () => {
    for (const bad of [null, undefined, 42, {}, []] as any[]) {
      expect(isUnusableSynthesis(bad)).toBe(false);
    }
  });
});

describe('buildExecutedActionsFallback', () => {
  it('reports each executed tool with its success/failure counts', () => {
    const text = buildExecutedActionsFallback([
      { name: 'call_meta_marketing_api' },
      { name: 'call_meta_marketing_api' },
      { name: 'call_meta_marketing_api', error: 'boom' },
      { name: 'list_knowledge_base_files' },
    ]);
    expect(text).toContain('call_meta_marketing_api');
    expect(text).toContain('2 succeeded');
    expect(text).toContain('1 failed');
    expect(text).toContain('list_knowledge_base_files');
  });

  it('warns the user not to re-run already-applied actions', () => {
    const text = buildExecutedActionsFallback([{ name: 'call_meta_marketing_api' }]);
    expect(text.toLowerCase()).toContain('already');
  });

  // ENG-1188: the root-cause fix recommendation was a ledger "listing every asset
  // produced (with URLs)" — a truthful recap of tool names is not the same as a
  // deliverable. extractMinimalToolResult (agentModeService.ts) already preserves
  // the URL on every asset-producing tool's result (save_file -> file_url,
  // create_html_file/create_html_from_template -> s3_url, generate_image ->
  // imageUrl, playwright_browser_take_screenshot -> screenshotUrl, generate_video
  // -> videoUrl, generate_voiceover -> audioUrl); the ledger just never read it.
  it('includes the asset URL when a succeeded call carries one', () => {
    const text = buildExecutedActionsFallback([
      { name: 'save_file', result: { success: true, file_url: 'https://s3.example.com/xCures-Master-Banners-V2.html' } },
    ]);
    expect(text).toContain('https://s3.example.com/xCures-Master-Banners-V2.html');
  });

  it('includes one URL per call when the same tool succeeds multiple times', () => {
    const text = buildExecutedActionsFallback([
      { name: 'playwright_browser_take_screenshot', result: { success: true, screenshotUrl: 'https://s3.example.com/a.jpg' } },
      { name: 'playwright_browser_take_screenshot', result: { success: true, screenshotUrl: 'https://s3.example.com/b.jpg' } },
    ]);
    expect(text).toContain('https://s3.example.com/a.jpg');
    expect(text).toContain('https://s3.example.com/b.jpg');
  });

  it('recognizes the URL field for every asset-producing tool extractMinimalToolResult preserves one for', () => {
    const text = buildExecutedActionsFallback([
      { name: 'create_html_file', result: { success: true, s3_url: 'https://s3.example.com/banner.html' } },
      { name: 'generate_image', result: { success: true, imageUrl: 'https://s3.example.com/hero.png' } },
      { name: 'generate_video', result: { success: true, videoUrl: 'https://s3.example.com/ad.mp4' } },
      { name: 'generate_voiceover', result: { success: true, audioUrl: 'https://s3.example.com/vo.mp3' } },
    ]);
    expect(text).toContain('https://s3.example.com/banner.html');
    expect(text).toContain('https://s3.example.com/hero.png');
    expect(text).toContain('https://s3.example.com/ad.mp4');
    expect(text).toContain('https://s3.example.com/vo.mp3');
  });

  it('does NOT include a URL for a failed call, even if the result carries a stale one', () => {
    const text = buildExecutedActionsFallback([
      { name: 'save_file', error: 'boom', result: { file_url: 'https://s3.example.com/stale.html' } },
    ]);
    expect(text).not.toContain('https://s3.example.com/stale.html');
  });

  it('does NOT include a URL for a deferred call', () => {
    const text = buildExecutedActionsFallback([
      { name: 'generate_image', result: { deferred: true, imageUrl: 'https://s3.example.com/not-yet.png' } },
    ]);
    expect(text).not.toContain('https://s3.example.com/not-yet.png');
  });

  it('omits a tool entirely when it produced no URL (e.g. a non-asset tool call)', () => {
    const text = buildExecutedActionsFallback([{ name: 'call_meta_marketing_api', result: { success: true } }]);
    expect(text).toContain('call_meta_marketing_api');
    expect(text.split('\n').filter((l) => l.trim().startsWith('http'))).toHaveLength(0);
  });

  it('never claims work happened when no tools ran', () => {
    const text = buildExecutedActionsFallback([]);
    expect(text).toContain('No actions were taken');
    expect(text).not.toContain('succeeded');
  });

  it('tolerates malformed ledger entries without throwing', () => {
    const text = buildExecutedActionsFallback([null, undefined, {}, { name: '' }] as any[]);
    expect(typeof text).toBe('string');
    expect(text.length).toBeGreaterThan(0);
  });
});

describe('buildExecutedActionsFooter', () => {
  it('returns null when no tools ran', () => {
    expect(buildExecutedActionsFooter([])).toBeNull();
  });

  it('includes the asset URL alongside the succeeded count', () => {
    const footer = buildExecutedActionsFooter([
      { name: 'save_file', result: { success: true, file_url: 'https://s3.example.com/xCures-Master-Banners-V2.html' } },
    ]);
    expect(footer).toContain('save_file');
    expect(footer).toContain('1 succeeded');
    expect(footer).toContain('https://s3.example.com/xCures-Master-Banners-V2.html');
  });
});
