import {
  DEFAULT_WORKING_STYLE,
  normalizeWorkingStyle,
  buildWorkingStyleInstruction,
  parseWorkingStyleRequest,
  applyWorkingStyleChange,
  workingStyleTelemetry,
} from '../utils/emmaWorkingStyle';

describe('ENG-1235 Emma working-style profile (pure resolver slice)', () => {
  it('normalizes unknown/partial input to defaults (structured, enumerated only)', () => {
    expect(normalizeWorkingStyle(undefined)).toEqual(DEFAULT_WORKING_STYLE);
    expect(normalizeWorkingStyle({ experience: 'expert', collaboration: 'bogus' })).toEqual({
      ...DEFAULT_WORKING_STYLE,
      experience: 'expert',
    });
    expect(normalizeWorkingStyle('free prose please' as any)).toEqual(DEFAULT_WORKING_STYLE);
  });

  it('Guided newcomer and Fast-moving expert produce materially different instructions (AC2/AC8)', () => {
    const guided = buildWorkingStyleInstruction({ experience: 'new', collaboration: 'guided', risk: 'conservative' });
    const fast = buildWorkingStyleInstruction({ experience: 'expert', collaboration: 'fast', risk: 'aggressive' });
    expect(guided).not.toEqual(fast);
    expect(guided).toMatch(/plain language/i);
    expect(guided).toMatch(/encourag/i);
    expect(fast).toMatch(/delta/i);
    expect(fast).not.toMatch(/plain language/i);
    // regression guard: every distinct profile renders a distinct instruction
    const all = new Set<string>();
    for (const experience of ['new', 'comfortable', 'expert'] as const)
      for (const collaboration of ['guided', 'direct', 'fast'] as const)
        for (const risk of ['conservative', 'balanced', 'aggressive'] as const)
          all.add(buildWorkingStyleInstruction({ experience, collaboration, risk }));
    expect(all.size).toBe(27);
  });

  it('every risk posture keeps safety/authorization gates authoritative (AC4)', () => {
    for (const risk of ['conservative', 'balanced', 'aggressive'] as const) {
      const s = buildWorkingStyleInstruction({ ...DEFAULT_WORKING_STYLE, risk });
      expect(s).toMatch(/never overrides? .*approval/i);
    }
  });

  it('always forbids demeaning the user while allowing evidence-led pushback (AC6)', () => {
    const s = buildWorkingStyleInstruction(DEFAULT_WORKING_STYLE);
    expect(s).toMatch(/never insult/i);
    expect(s).toMatch(/push back/i);
  });

  it('parses natural-language change requests from chat (AC5)', () => {
    expect(parseWorkingStyleRequest('can you be more concise')).toEqual({ collaboration: 'fast' });
    expect(parseWorkingStyleRequest('please walk me through this')).toEqual({ collaboration: 'guided' });
    expect(parseWorkingStyleRequest("slow down, I'm new to ads")).toEqual({ collaboration: 'guided', experience: 'new' });
    expect(parseWorkingStyleRequest("I'm comfortable taking more risk")).toEqual({ risk: 'aggressive' });
    expect(parseWorkingStyleRequest('reset your working style')).toBe('reset');
    expect(parseWorkingStyleRequest('launch my campaign')).toBeNull();
  });

  it('applies changes and resets without silently reclassifying other dimensions', () => {
    const cur = { experience: 'expert', collaboration: 'direct', risk: 'balanced' } as const;
    expect(applyWorkingStyleChange(cur, { risk: 'conservative' })).toEqual({ ...cur, risk: 'conservative' });
    expect(applyWorkingStyleChange(cur, 'reset')).toEqual(DEFAULT_WORKING_STYLE);
  });

  it('telemetry exposes only the resolved enums', () => {
    expect(workingStyleTelemetry({ experience: 'new' } as any)).toBe(
      'working_style=new/direct/balanced',
    );
  });
});
