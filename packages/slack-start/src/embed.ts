/**
 * Script-tag entry, served by the backend at /embed/slack-start.js:
 *
 *   <script src="https://api.agentweb.pro/embed/slack-start.js" defer></script>
 *   <button data-agentweb-slack-start>Get started in Slack</button>
 *
 * The API base defaults to the origin the script was loaded from; override with
 * data-api-base on the <script> or on an individual trigger.
 */
import { autoBind, closeAllSlackStart, mountSlackStart, openSlackStart } from './mount';

declare global {
  interface Window {
    AgentWebSlackStart?: {
      open: typeof openSlackStart;
      mount: typeof mountSlackStart;
      autoBind: typeof autoBind;
      closeAll: typeof closeAllSlackStart;
      apiBase: string;
    };
  }
}

(function () {
  if (window.AgentWebSlackStart) return;
  const script = document.currentScript as HTMLScriptElement | null;
  const fromAttr = script?.getAttribute('data-api-base');
  let apiBase = 'https://api.agentweb.pro';
  if (fromAttr) apiBase = fromAttr;
  else if (script?.src) apiBase = new URL(script.src, window.location.href).origin;
  apiBase = apiBase.replace(/\/+$/, '');
  window.AgentWebSlackStart = { open: openSlackStart, mount: mountSlackStart, autoBind, closeAll: closeAllSlackStart, apiBase };
  const start = () => autoBind({ apiBase });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
