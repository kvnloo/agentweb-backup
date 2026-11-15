import {
  BRAND_MESSAGING_CONTEXT_MAX_CHARS,
  brandMessagingContextFromGuidelines,
  buildBrandMessagingContext,
} from '../services/brandMessagingContext';

// Shape stored on User.brandGuidelines.brandData (services/db.ts).
const BRAND_DATA = {
  brandName: 'Acme Isolation',
  tagline: 'Browser isolation for mid-market security teams',
  valueProposition: 'Stops shadow-IT data leaks without blocking employees.',
  keyMessages: ['No agents to install', 'Deploys in a day'],
  toneOfVoice: 'Warm, concise, founder-led',
  brandPersonality: 'Pragmatic',
  brandValues: ['Transparency'],
  targetAudience: 'CISOs',
  primaryColor: '#FF0000',
  primaryColorEnd: '#00FF00',
  secondaryColor: '#123456',
  fontFamily: 'Inter',
  isGradient: true,
  logoUrl: 'https://cdn.example.com/logo.png',
  founders: [],
};

describe('buildBrandMessagingContext (ENG-2967)', () => {
  it('includes brand name, offer, value proposition, key messages and voice', () => {
    const block = buildBrandMessagingContext(BRAND_DATA);
    expect(block).toContain('Acme Isolation');
    expect(block).toContain('Browser isolation for mid-market security teams');
    expect(block).toContain('Stops shadow-IT data leaks without blocking employees.');
    expect(block).toContain('No agents to install');
    expect(block).toContain('Deploys in a day');
    expect(block).toContain('Warm, concise, founder-led');
  });

  it('omits colors, typography and logos', () => {
    const block = buildBrandMessagingContext(BRAND_DATA);
    for (const visual of ['#FF0000', '#00FF00', '#123456', 'Inter', 'logo.png']) {
      expect(block).not.toContain(visual);
    }
    expect(block).not.toMatch(/color|font|logo/i);
  });

  it('never exceeds the 1500-char cap, even with oversized fields', () => {
    const huge = 'x'.repeat(5000);
    const block = buildBrandMessagingContext({
      brandName: huge,
      tagline: huge,
      valueProposition: huge,
      keyMessages: [huge, huge, huge, huge, huge, huge],
      toneOfVoice: huge,
      brandPersonality: huge,
    });
    expect(BRAND_MESSAGING_CONTEXT_MAX_CHARS).toBe(1500);
    expect(block.length).toBeLessThanOrEqual(1500);
    // Per-field caps keep later fields (voice) from being crowded out.
    expect(block).toContain('Voice/tone:');
  });

  it('honours a smaller explicit cap', () => {
    expect(buildBrandMessagingContext(BRAND_DATA, 40).length).toBeLessThanOrEqual(40);
  });

  it('returns empty for missing or visual-only brand data', () => {
    expect(buildBrandMessagingContext(undefined)).toBe('');
    expect(buildBrandMessagingContext(null)).toBe('');
    expect(buildBrandMessagingContext('not an object')).toBe('');
    expect(buildBrandMessagingContext({ primaryColor: '#fff', fontFamily: 'Inter', keyMessages: ['', '  '] })).toBe('');
  });

  it('collapses whitespace and ignores non-string key messages', () => {
    const block = buildBrandMessagingContext({ brandName: '  Acme \n\n Co  ', keyMessages: ['One', 42, null, 'Two'] });
    expect(block).toContain('Brand: Acme Co');
    expect(block).toContain('Key messages: One; Two');
  });
});

describe('brandMessagingContextFromGuidelines — readBrandGuidelines result shape', () => {
  it('reads brandData from a real-shaped result that has no `.content` field (CRM invite-note fix)', () => {
    // readBrandGuidelines returns { exists, brandData, formattedContent }; the
    // invite-note route used to read `.content`, which is always undefined.
    const result = {
      success: true,
      exists: true,
      brandData: BRAND_DATA,
      attachments: [],
      formattedContent: '<strong>🎨 Brand Guidelines Retrieved</strong><br>…Primary Color: #FF0000',
    };
    expect((result as any).content).toBeUndefined();
    const block = brandMessagingContextFromGuidelines(result);
    expect(block).toContain('Acme Isolation');
    expect(block).toContain('Warm, concise, founder-led');
    expect(block).not.toContain('#FF0000');
    expect(block).not.toContain('<strong>');
  });

  it('returns empty when guidelines do not exist or the read failed', () => {
    expect(brandMessagingContextFromGuidelines({ success: true, exists: false, brandData: {}, attachments: [] })).toBe('');
    expect(brandMessagingContextFromGuidelines({ success: false, message: 'User not found', exists: false })).toBe('');
    expect(brandMessagingContextFromGuidelines({ success: false, message: 'Failed to read brand guidelines' })).toBe('');
    expect(brandMessagingContextFromGuidelines(null)).toBe('');
  });
});
