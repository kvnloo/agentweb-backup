/**
 * Migration script: Add 429 bot-protection guidance to the Browser Automation skill's systemPrompt.
 *
 * Usage:
 *   NODE_ENV=development npx ts-node src/scripts/patch-browser-skill-429-guidance.ts
 *   NODE_ENV=production  npx ts-node src/scripts/patch-browser-skill-429-guidance.ts
 *
 * Idempotent: skips if the guidance is already present.
 */

export const BROWSER_SKILL_ID = '1ae6104b-eb2d-4297-adc2-1b6f3b177497';

export const GUIDANCE_MARKER = '## 429 Errors on Static Assets';

export const ADDITIONAL_PROMPT = `
## 429 Errors on Static Assets — Bot Protection, Not a Broken Site

When checking a website with playwright_browser_network_requests, you may see 429 (Too Many Requests) responses for static assets like CSS, JavaScript, fonts, or images — even when the website is functioning correctly for real visitors. This happens because Cloudflare and similar security systems rate-limit or block headless browsers on asset requests.

Do NOT report a website as broken or returning errors solely because static assets returned 429.

To correctly assess website health:
1. Check whether the main HTML document (the page itself) loaded with a 2xx status — if so, the site is reachable.
2. Use playwright_browser_evaluate to check document.title and key content — if the page has meaningful text/structure, it loaded.
3. Only flag a site as broken if the HTML itself returns an error (4xx/5xx), the page is a Cloudflare challenge wall, or the page content is genuinely missing/empty.
4. If static assets (CSS/JS) return 429 but the HTML loaded and content is present, note this as "the automated browser may be rate-limited by bot protection, but the site appears functional for regular visitors" — not as a site error.`;

async function main() {
  const { SkillService } = await import('../services/skillService');
  const skillService = new SkillService();

  const skill = await skillService.getSkill(BROWSER_SKILL_ID);
  if (!skill) {
    console.error(`Skill ${BROWSER_SKILL_ID} not found.`);
    process.exit(1);
  }

  if ((skill.systemPrompt ?? '').includes(GUIDANCE_MARKER)) {
    console.log('Guidance already present — skipping.');
    return;
  }

  skill.systemPrompt = (skill.systemPrompt ?? '') + ADDITIONAL_PROMPT;
  await skillService.updateSkill(skill);
  console.log(`Patched Browser Automation skill (${BROWSER_SKILL_ID}) with 429 guidance.`);
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Patch failed:', err);
      process.exit(1);
    });
}
