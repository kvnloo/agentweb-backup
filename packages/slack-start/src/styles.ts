/**
 * Scoped styles for the wizard (approved intake mock, ENG-2782 intake.html).
 * Everything hangs off .aw-ss-root and is themeable with CSS variables, e.g.
 *   [data-agentweb-slack-start-theme] or :root { --aw-ss-accent: #0a66c2; }
 */
export const STYLE_ID = 'aw-slack-start-styles';

export const CSS = `
.aw-ss-root{--aw-ss-accent:#6d4fd8;--aw-ss-text:#1d1c1d;--aw-ss-muted:#666;--aw-ss-border:#ddd;--aw-ss-bg:#fff;--aw-ss-track:#e6e6ea;--aw-ss-button:#1d1c1d;--aw-ss-button-text:#fff;--aw-ss-error:#b42318;--aw-ss-radius:10px;--aw-ss-font:-apple-system,"Segoe UI",Helvetica,Arial,sans-serif;position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:rgba(17,17,26,.55);font-family:var(--aw-ss-font);color:var(--aw-ss-text)}
.aw-ss-root *{box-sizing:border-box}
.aw-ss-panel{position:relative;background:var(--aw-ss-bg);width:min(860px,100vw);max-height:100vh;overflow:auto;border-radius:16px;padding:20px 24px 28px;box-shadow:0 20px 60px rgba(0,0,0,.25)}
.aw-ss-panel:focus{outline:none}
.aw-ss-close{position:absolute;right:12px;top:10px;border:0;background:transparent;font-size:22px;line-height:1;color:var(--aw-ss-muted);cursor:pointer;padding:6px;border-radius:8px}
.aw-ss-bar{width:min(440px,100%);margin:6px auto 0;display:flex;align-items:center;gap:14px;color:#999}
.aw-ss-back{border:0;background:transparent;font-size:22px;line-height:1;color:var(--aw-ss-muted);cursor:pointer;padding:2px 8px;border-radius:8px}
.aw-ss-back[disabled]{visibility:hidden}
.aw-ss-track{flex:1;height:7px;border-radius:4px;background:var(--aw-ss-track);overflow:hidden}
.aw-ss-fill{display:block;height:100%;background:var(--aw-ss-accent);border-radius:4px;transition:width .25s ease}
.aw-ss-h{font-size:clamp(24px,4vw,34px);letter-spacing:-.5px;text-align:center;margin:16px 0 4px;font-weight:800}
.aw-ss-sub{text-align:center;color:var(--aw-ss-muted);font-size:14px;margin:0 0 14px}
.aw-ss-form{width:min(440px,100%);margin:0 auto}
.aw-ss-lbl{display:block;font-size:12px;font-weight:700;color:#555;margin:0 0 4px}
.aw-ss-in{width:100%;border:1px solid #ccc;border-radius:var(--aw-ss-radius);padding:12px 14px;font-size:15px;margin:0 0 10px;font-family:inherit;color:inherit;background:#fff}
.aw-ss-in[readonly]{background:#f6f6f8;color:var(--aw-ss-muted)}
.aw-ss-list{width:min(640px,100%);margin:0 auto;display:grid;grid-template-columns:1fr;gap:8px;border:0;padding:0}
.aw-ss-list.aw-ss-two{grid-template-columns:1fr 1fr}
.aw-ss-list.aw-ss-three{width:min(780px,100%);grid-template-columns:1fr 1fr 1fr}
.aw-ss-group{grid-column:1/-1;color:var(--aw-ss-accent);font-weight:700;font-size:14px;margin:6px 0 0}
.aw-ss-o{position:relative;border:1px solid var(--aw-ss-border);border-radius:var(--aw-ss-radius);padding:10px 14px;display:flex;align-items:center;gap:10px;font-size:14px;cursor:pointer;background:#fff}
.aw-ss-o input{position:absolute;opacity:0;width:1px;height:1px;margin:0}
.aw-ss-o .aw-ss-mark{margin-left:auto;flex:none;width:20px;height:20px;border:1px solid #ccc;background:#f6f6f8;border-radius:50%}
.aw-ss-o.aw-ss-multi .aw-ss-mark{border-radius:5px;color:#fff;font-size:13px;text-align:center;line-height:18px}
.aw-ss-o.aw-ss-on{border-color:var(--aw-ss-accent)}
.aw-ss-o.aw-ss-on .aw-ss-mark{border:6px solid var(--aw-ss-accent);background:#fff}
.aw-ss-o.aw-ss-multi.aw-ss-on .aw-ss-mark{border:1px solid var(--aw-ss-accent);background:var(--aw-ss-accent)}
.aw-ss-o.aw-ss-multi.aw-ss-on .aw-ss-mark::after{content:"\\2713"}
.aw-ss-o:has(input:focus-visible){outline:3px solid var(--aw-ss-accent);outline-offset:2px}
.aw-ss-note{width:min(640px,100%);margin:12px auto 0;background:#f4f2ff;border:1px solid #d9d2ff;border-radius:8px;padding:8px 10px;font-size:13px;color:#3d2f8f}
.aw-ss-btn{display:block;width:min(640px,100%);margin:14px auto 0;background:var(--aw-ss-button);color:var(--aw-ss-button-text);border:0;border-radius:var(--aw-ss-radius);padding:12px;text-align:center;font-weight:700;font-size:15px;cursor:pointer;font-family:inherit}
.aw-ss-form .aw-ss-btn{width:100%}
.aw-ss-btn[disabled]{opacity:.45;cursor:not-allowed}
.aw-ss-root button:focus-visible,.aw-ss-in:focus{outline:3px solid var(--aw-ss-accent);outline-offset:2px}
.aw-ss-err{width:min(640px,100%);margin:10px auto 0;color:var(--aw-ss-error);font-size:14px;text-align:center}
.aw-ss-spin{width:22px;height:22px;border:3px solid #ddd;border-top-color:var(--aw-ss-accent);border-radius:50%;margin:48px auto 14px;animation:aw-ss-rot 1s linear infinite}
.aw-ss-captcha{display:flex;justify-content:center;margin:4px 0 6px}
@keyframes aw-ss-rot{to{transform:rotate(360deg)}}
@media (max-width:560px){.aw-ss-panel{border-radius:0;min-height:100vh;padding:16px}.aw-ss-list.aw-ss-two,.aw-ss-list.aw-ss-three{grid-template-columns:1fr}}
@media (prefers-reduced-motion:reduce){.aw-ss-fill{transition:none}.aw-ss-spin{animation:none}}
`;

export function injectStyles(doc: Document = document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  doc.head.appendChild(style);
}
