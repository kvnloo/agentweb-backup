/** Cloudflare Turnstile, loaded only when the backend config publishes a site key. */
declare global {
  interface Window {
    turnstile?: {
      render(el: HTMLElement, opts: Record<string, unknown>): string;
      reset(id?: string): void;
      remove(id?: string): void;
    };
  }
}

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let loading: Promise<void> | null = null;

function loadTurnstile(nonce?: string): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  if (loading) return loading;
  loading = new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SCRIPT_SRC;
    s.async = true;
    if (nonce) s.setAttribute('nonce', nonce);
    s.onload = () => resolve();
    s.onerror = () => {
      loading = null;
      reject(new Error('captcha failed to load'));
    };
    document.head.appendChild(s);
  });
  return loading;
}

/** Renders the widget into `el`; returns a cleanup function. */
export function mountTurnstile(
  el: HTMLElement,
  siteKey: string,
  onToken: (token: string | null) => void,
  onError: () => void,
  nonce?: string,
): () => void {
  let id: string | undefined;
  let cancelled = false;
  loadTurnstile(nonce)
    .then(() => {
      if (cancelled) return;
      if (!window.turnstile) return onError();
      id = window.turnstile.render(el, {
        sitekey: siteKey,
        callback: (t: string) => onToken(t),
        'expired-callback': () => onToken(null),
        'error-callback': () => onError(),
      });
    })
    .catch(onError);
  return () => {
    cancelled = true;
    if (id && window.turnstile) window.turnstile.remove(id);
  };
}
