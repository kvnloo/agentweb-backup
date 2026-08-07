// ENG-736: a successfully deployed landing page whose live URL the final message
// withholds (e.g. the model falsely reports the deployment "timed out") must have
// that URL surfaced. These tests pin the deterministic reconciler that guarantees
// a real deployedUrl/previewUrl is never dropped from the user-facing reply.

import {
  reconcileLandingDeploymentReport,
  collectSuccessfulLandingUrls,
} from '../utils/landingDeploymentReport';

describe('landingDeploymentReport', () => {
  const DEPLOYED_URL = 'https://eng287-prod-verify.agentwebforms.com/cold-outreach-apply-pilot';

  describe('collectSuccessfulLandingUrls', () => {
    it('picks up a successful get_deployment_status result', () => {
      const urls = collectSuccessfulLandingUrls([
        { name: 'get_deployment_status', result: { status: 'deployed', buildStatus: 'success', deployedUrl: DEPLOYED_URL } },
      ]);
      expect(urls).toEqual([{ url: DEPLOYED_URL, name: undefined }]);
    });

    it('picks up a deployed generate_landing_page record and its name', () => {
      const urls = collectSuccessfulLandingUrls([
        { name: 'generate_landing_page', result: { status: 'deployed', deployedUrl: DEPLOYED_URL, name: 'Cold Outreach' } },
      ]);
      expect(urls).toEqual([{ url: DEPLOYED_URL, name: 'Cold Outreach' }]);
    });

    it('prefers customDomainUrl over deployedUrl', () => {
      const urls = collectSuccessfulLandingUrls([
        { name: 'deploy_landing_page', result: { status: 'deployed', deployedUrl: DEPLOYED_URL, customDomainUrl: 'https://custom.example.com' } },
      ]);
      expect(urls).toEqual([{ url: 'https://custom.example.com', name: undefined }]);
    });

    it('picks up a successful get_landing_page_preview_url result', () => {
      const urls = collectSuccessfulLandingUrls([
        { name: 'get_landing_page_preview_url', result: { buildStatus: 'success', previewUrl: 'https://preview.example.com' } },
      ]);
      expect(urls).toEqual([{ url: 'https://preview.example.com', name: undefined }]);
    });

    it('dedupes the same URL surfaced by multiple tools', () => {
      const urls = collectSuccessfulLandingUrls([
        { name: 'generate_landing_page', result: { status: 'deployed', deployedUrl: DEPLOYED_URL } },
        { name: 'get_deployment_status', result: { status: 'deployed', buildStatus: 'success', deployedUrl: DEPLOYED_URL } },
      ]);
      expect(urls).toEqual([{ url: DEPLOYED_URL, name: undefined }]);
    });

    // FAIL cases: nothing collected
    it('ignores a failed deployment', () => {
      expect(collectSuccessfulLandingUrls([
        { name: 'generate_landing_page', result: { status: 'failed', errorMessage: 'V0_CALL_TIMEOUT' } },
      ])).toEqual([]);
    });

    it('ignores an in-flight / non-success build status', () => {
      expect(collectSuccessfulLandingUrls([
        { name: 'get_deployment_status', result: { status: 'deploying', buildStatus: 'building', deployedUrl: DEPLOYED_URL } },
        { name: 'get_landing_page_preview_url', result: { buildStatus: 'not_found' } },
      ])).toEqual([]);
    });

    it('ignores a deployed status with no URL', () => {
      expect(collectSuccessfulLandingUrls([
        { name: 'deploy_landing_page', result: { status: 'deployed' } },
      ])).toEqual([]);
    });

    it('ignores an errored ledger entry even if the result looks successful', () => {
      expect(collectSuccessfulLandingUrls([
        { name: 'get_deployment_status', error: 'boom', result: { buildStatus: 'success', deployedUrl: DEPLOYED_URL } },
      ])).toEqual([]);
    });

    it('ignores unrelated tools', () => {
      expect(collectSuccessfulLandingUrls([
        { name: 'list_landing_pages', result: { pages: [{ deployedUrl: DEPLOYED_URL }] } },
        { name: 'generate_image', result: { imageUrl: 'https://img.example.com/a.png' } },
      ])).toEqual([]);
    });
  });

  describe('reconcileLandingDeploymentReport', () => {
    const failureText =
      'I have successfully drafted the content for your landing page, but the final deployment step timed out. You can review your saved draft in the dashboard.';

    it('appends the deployed URL when the final message withholds it (the ENG-736 bug)', () => {
      const out = reconcileLandingDeploymentReport(failureText, [
        { name: 'get_deployment_status', result: { status: 'deployed', buildStatus: 'success', deployedUrl: DEPLOYED_URL } },
      ]);
      expect(out).not.toBe(failureText);
      expect(out).toContain(failureText);
      expect(out).toContain(DEPLOYED_URL);
    });

    it('includes the page name when known', () => {
      const out = reconcileLandingDeploymentReport(failureText, [
        { name: 'generate_landing_page', result: { status: 'deployed', deployedUrl: DEPLOYED_URL, name: 'Cold Outreach Apply Pilot' } },
      ]);
      expect(out).toContain('Cold Outreach Apply Pilot');
      expect(out).toContain(DEPLOYED_URL);
    });

    it('leaves the message unchanged when it already contains the URL', () => {
      const good = `Your page is live at ${DEPLOYED_URL} — enjoy!`;
      const out = reconcileLandingDeploymentReport(good, [
        { name: 'get_deployment_status', result: { status: 'deployed', buildStatus: 'success', deployedUrl: DEPLOYED_URL } },
      ]);
      expect(out).toBe(good);
    });

    it('matches a URL embedded in a markdown link (no duplicate append)', () => {
      const good = `Your page is live: [preview](${DEPLOYED_URL}).`;
      const out = reconcileLandingDeploymentReport(good, [
        { name: 'get_deployment_status', result: { status: 'deployed', buildStatus: 'success', deployedUrl: DEPLOYED_URL } },
      ]);
      expect(out).toBe(good);
    });

    it('leaves the message unchanged when no deployment succeeded', () => {
      const out = reconcileLandingDeploymentReport(failureText, [
        { name: 'generate_landing_page', result: { status: 'failed', errorMessage: 'V0_CALL_TIMEOUT' } },
      ]);
      expect(out).toBe(failureText);
    });

    it('does not fabricate a message when the final content is empty', () => {
      expect(reconcileLandingDeploymentReport('', [
        { name: 'get_deployment_status', result: { status: 'deployed', buildStatus: 'success', deployedUrl: DEPLOYED_URL } },
      ])).toBe('');
      expect(reconcileLandingDeploymentReport('   ', [
        { name: 'get_deployment_status', result: { status: 'deployed', buildStatus: 'success', deployedUrl: DEPLOYED_URL } },
      ])).toBe('   ');
    });

    it('handles a missing/non-array ledger without throwing', () => {
      expect(reconcileLandingDeploymentReport(failureText, undefined as any)).toBe(failureText);
      expect(reconcileLandingDeploymentReport(failureText, [] as any)).toBe(failureText);
    });
  });
});
