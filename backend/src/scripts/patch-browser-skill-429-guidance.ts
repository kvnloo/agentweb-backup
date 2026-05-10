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

## CRITICAL: 429 Errors on Static Assets Are NOT Site Failures

When you use playwright_browser_network_requests or see console errors, you will often observe HTTP 429 (Too Many Requests) responses for static assets — CSS files, JavaScript bundles, fonts, images. This is NORMAL for automated/headless browsers visiting sites protected by Cloudflare or similar bot-protection services. The server rate-limits the automated browser's asset requests but serves the site correctly to real human visitors.

**NEVER report 429 errors on static assets (CSS, JS, fonts, images) as a site failure, hosting problem, or server misconfiguration.** This is a false positive caused by bot protection — not an issue with the website itself.

**NEVER describe 429 console errors as "critical", "urgent", or indicative of a broken site.**

The correct assessment process:
1. Check ONLY the main HTML document status: if https://example.com/ returned 200, the site is reachable.
2. Run playwright_browser_evaluate: if document.title has content and document.body.innerHTML.length > 10000, the page loaded successfully.
3. A site is broken ONLY if: the HTML document itself (not assets) returns 4xx/5xx, OR the page shows a Cloudflare challenge/block page, OR document.body.innerHTML is empty/trivially small.
4. When static assets return 429 but the HTML loaded: state "Note: the automated browser was rate-limited by bot protection on some static assets. This is expected behavior and does not affect the site for real visitors." — then move on to reporting actual observable issues.`;

async function main() {
  const { SkillService } = await import('../services/skillService');
  const skillService = new SkillService();

  const skill = await skillService.getSkill(BROWSER_SKILL_ID);
  if (!skill) {
    console.error(`Skill ${BROWSER_SKILL_ID} not found.`);
    process.exit(1);
  }

  // Strip any previously applied version of the guidance before re-applying
  const stripped = (skill.systemPrompt ?? '')
    .split('\n\n## CRITICAL: 429')[0]
    .split('\n\n## 429 Errors on Static Assets')[0];

  if (stripped + ADDITIONAL_PROMPT === skill.systemPrompt) {
    console.log('Guidance already up to date — skipping.');
    return;
  }

  skill.systemPrompt = stripped + ADDITIONAL_PROMPT;
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
