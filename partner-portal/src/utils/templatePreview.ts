import DOMPurify from "dompurify";

export interface TemplateContent {
  html_content: string;
}

export const getPreviewBaseHref = (): string | undefined => {
  if (typeof window === "undefined" || !window.location?.origin) return undefined;
  return `${window.location.origin}/`;
};

const CSP_CONTENT =
  "default-src 'none'; " +
  "script-src https: http: 'unsafe-inline'; " +
  "connect-src 'none'; " +
  "img-src https: http: data:; " +
  "media-src https: http: data:; " +
  "style-src https: http: 'unsafe-inline'; " +
  "font-src https: http: data:; " +
  "frame-src 'none'; " +
  "object-src 'none'; " +
  "base-uri https: http:; " +
  "form-action 'none'";

const CSP_META_TAG = `<meta http-equiv="Content-Security-Policy" content="${CSP_CONTENT}">`;

const LOCAL_STORAGE_SHIM = `<script>
(() => {
  try {
    const testKey = "__preview_test__";
    window.localStorage.setItem(testKey, "1");
    window.localStorage.removeItem(testKey);
  } catch (err) {
    let store = {};
    Object.defineProperty(window, "localStorage", {
      value: {
        getItem: (key) => (key in store ? store[key] : null),
        setItem: (key, value) => { store[key] = String(value); },
        removeItem: (key) => { delete store[key]; },
        clear: () => { store = {}; },
      },
      configurable: true,
    });
  }
})();
</script>`;

const injectCspMeta = (html: string, baseHref?: string): string => {
  const baseTag = baseHref ? `<base href="${baseHref}">` : "";
  const headInject = `${CSP_META_TAG}\n  ${baseTag}\n  ${LOCAL_STORAGE_SHIM}`.trim();

  if (/<meta[^>]+http-equiv=["']Content-Security-Policy["']/i.test(html)) return html;

  if (/<\s*head\b[^>]*>/i.test(html)) {
    return html.replace(/<\s*head\b[^>]*>/i, (match) => `${match}\n  ${headInject}`);
  }

  if (/<\s*html\b[^>]*>/i.test(html)) {
    return html.replace(/<\s*html\b[^>]*>/i, (match) => `${match}\n<head>\n  ${headInject}\n</head>`);
  }

  return `<!DOCTYPE html><html><head>${headInject}</head><body>${html}</body></html>`;
};

const sanitizeHtml = (html: string, wholeDocument: boolean): string => {
  const scriptHook = (node: Element, data: { tagName?: string }) => {
    if (data.tagName !== "script") return;
    const src = node.getAttribute("src")?.trim() ?? "";
    if (src && /^(javascript:|data:)/i.test(src)) node.remove();
  };

  DOMPurify.addHook("uponSanitizeElement", scriptHook);
  const result = DOMPurify.sanitize(html, {
    ...(wholeDocument ? { WHOLE_DOCUMENT: true } : { USE_PROFILES: { html: true } }),
    ADD_TAGS: ["style", "script", "meta", "head", "base"],
    ADD_ATTR: ["src", "type", "async", "defer", "crossorigin", "nomodule", "integrity",
      "referrerpolicy", "http-equiv", "content", "href"],
  });
  DOMPurify.removeHook("uponSanitizeElement");
  return result;
};

const isFullDocumentHtml = (html: string): boolean => {
  const withoutComments = html.replace(/^\s*(?:<!--[\s\S]*?-->\s*)*/g, "");
  if (/^\s*<\s*!doctype/i.test(withoutComments)) return true;
  if (/^\s*<\s*html\b/i.test(withoutComments)) return true;
  return /<\s*html\b/i.test(html);
};

export const buildPreviewSrcDoc = (
  template: TemplateContent,
  options?: { baseHref?: string }
): string => {
  const html = template.html_content;
  const isFullDocument = isFullDocumentHtml(html);

  if (isFullDocument) {
    return sanitizeHtml(injectCspMeta(html, options?.baseHref), true);
  }

  const sanitizedFragment = sanitizeHtml(html, false);
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${CSP_META_TAG}
  ${options?.baseHref ? `<base href="${options.baseHref}">` : ""}
  ${LOCAL_STORAGE_SHIM}
  <style>
    body { margin: 0; padding: 20px; font-family: Arial, sans-serif; font-size: 14px; line-height: 1.4; color: #333333; background-color: #ffffff; }
    * { box-sizing: border-box; }
  </style>
</head>
<body>${sanitizedFragment}</body>
</html>`;
};
