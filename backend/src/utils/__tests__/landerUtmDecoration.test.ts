/**
 * ENG-726 — lander outbound-link decoration. One block per acceptance criterion.
 * The emitted browser script is executed against a minimal fake window/document
 * and its output compared with the shared resolver (resolveLanderParams).
 */
import vm from "vm";
import { resolveLanderParams, type UtmConfig } from "../landerUtm";
import {
  buildLanderUtmDecorationScript,
  injectUtmDecorationIntoLayout,
  injectUtmDecorationIntoLayoutFiles,
  resolveConfiguredLanderParams,
  UTM_DECORATION_START,
} from "../landerUtmDecoration";

const LAYOUT = `export default function RootLayout({ children }) {\n  return (\n    <html lang="en">\n      <head>\n      </head>\n      <body>{children}</body>\n    </html>\n  );\n}\n`;

/** Run the decoration script on a page URL, click a link, return the link's final href. */
function clickThrough(
  layers: { override?: UtmConfig; customerDefault?: UtmConfig },
  pageUrl: string,
  linkHref: string,
): string {
  const configured = resolveConfiguredLanderParams(layers);
  if (!configured) throw new Error("no config");
  const listeners: Array<(e: unknown) => void> = [];
  const loc = new URL(pageUrl);
  const ctx = {
    URL,
    URLSearchParams,
    window: { location: { search: loc.search, href: loc.href, origin: loc.origin } },
    document: {
      addEventListener: (type: string, fn: (e: unknown) => void) => {
        if (type === "click") listeners.push(fn);
      },
    },
  };
  vm.runInNewContext(buildLanderUtmDecorationScript(configured), ctx);
  const anchor = { nodeName: "A", href: linkHref, parentNode: null };
  const child = { nodeName: "SPAN", parentNode: anchor };
  listeners.forEach((fn) => fn({ target: child }));
  return anchor.href;
}

function paramsOf(href: string): Record<string, string> {
  return Object.fromEntries(new URL(href).searchParams.entries());
}

const DEST = "https://customer.example.com/signup";

describe("ENG-726 AC1/AC2 — same shared resolver, visitor > override > default > absent", () => {
  const override: UtmConfig = { utm_source: "ovr_src", utm_campaign: "ovr_cmp" };
  const customerDefault: UtmConfig = { utm_source: "def_src", utm_medium: "def_med", utm_term: "def_term" };

  const cases: Array<[string, Record<string, string>]> = [
    ["no visitor params", {}],
    ["visitor sets source only", { utm_source: "fb" }],
    ["visitor sets medium + content", { utm_medium: "paid", utm_content: "ad1" }],
    ["visitor blank value falls through", { utm_source: "  " }],
  ];

  it.each(cases)("%s matches resolveLanderParams per key", (_label, visitor) => {
    const qs = new URLSearchParams(visitor).toString();
    const out = paramsOf(clickThrough({ override, customerDefault }, `https://lp.example.com/?${qs}`, DEST));
    const expected = resolveLanderParams({ visitor, override, customerDefault }).params;
    expect(out).toEqual(expected);
  });

  it("override beats default; default fills keys the override leaves unset", () => {
    const out = paramsOf(clickThrough({ override, customerDefault }, "https://lp.example.com/", DEST));
    expect(out.utm_source).toBe("ovr_src");
    expect(out.utm_medium).toBe("def_med");
    expect(out.utm_campaign).toBe("ovr_cmp");
  });

  it("a key no layer supplies is absent, never key=", () => {
    const href = clickThrough({ customerDefault: { utm_source: "d" } }, "https://lp.example.com/", DEST);
    expect(href).not.toMatch(/utm_medium/);
  });
});

describe("ENG-726 AC3 — click IDs survive unmodified", () => {
  it("gclid and fbclid pass through verbatim", () => {
    const out = paramsOf(
      clickThrough({ customerDefault: { utm_source: "d" } }, "https://lp.example.com/?gclid=Cj0K-abc_123&fbclid=IwAR9xyz", DEST),
    );
    expect(out.gclid).toBe("Cj0K-abc_123");
    expect(out.fbclid).toBe("IwAR9xyz");
  });
});

describe("ENG-726 AC4 — aw_lander provenance without touching customer UTMs", () => {
  it("adds aw_lander=1 and leaves utm_source as the customer's", () => {
    const out = paramsOf(clickThrough({ customerDefault: { utm_source: "customer" } }, "https://lp.example.com/", DEST));
    expect(out.aw_lander).toBe("1");
    expect(out.utm_source).toBe("customer");
  });

  it("never overwrites a param already on the destination link", () => {
    const out = paramsOf(
      clickThrough({ customerDefault: { utm_source: "customer" } }, "https://lp.example.com/?utm_source=fb", `${DEST}?utm_source=explicit`),
    );
    expect(out.utm_source).toBe("explicit");
  });

  it("leaves same-origin and non-http links alone", () => {
    expect(clickThrough({ customerDefault: { utm_source: "c" } }, "https://lp.example.com/", "https://lp.example.com/about")).toBe(
      "https://lp.example.com/about",
    );
    expect(clickThrough({ customerDefault: { utm_source: "c" } }, "https://lp.example.com/", "mailto:a@b.co")).toBe("mailto:a@b.co");
  });
});

describe("ENG-726 AC5 — no default and no override: byte-identical", () => {
  it.each([[{}], [{ override: null, customerDefault: null }], [{ override: {}, customerDefault: {} }]])(
    "injects nothing for %j",
    (layers) => {
      const files = [{ path: "app/layout.tsx", content: Buffer.from(LAYOUT) }];
      expect(injectUtmDecorationIntoLayoutFiles(files, layers as any)).toBe(false);
      expect(files[0].content.toString()).toBe(LAYOUT);
    },
  );
});

describe("ENG-726 AC6 — deterministic", () => {
  it("same inputs produce byte-identical layouts, and re-injection does not duplicate", () => {
    const layers = { override: { utm_campaign: "x" }, customerDefault: { utm_source: "y" } };
    const a = [{ path: "app/layout.tsx", content: Buffer.from(LAYOUT) }];
    const b = [{ path: "app/layout.tsx", content: Buffer.from(LAYOUT) }];
    expect(injectUtmDecorationIntoLayoutFiles(a, layers)).toBe(true);
    expect(injectUtmDecorationIntoLayoutFiles(b, layers)).toBe(true);
    expect(a[0].content.equals(b[0].content)).toBe(true);
    const twice = injectUtmDecorationIntoLayout(a[0].content.toString(), resolveConfiguredLanderParams(layers));
    expect(twice.split(UTM_DECORATION_START).length - 1).toBe(1);
  });
});

describe("ENG-726 — injection safety", () => {
  it("a config value cannot break out of the inline script", () => {
    const evil = { customerDefault: { utm_source: "</script><img src=x onerror=alert(1)>" } };
    const out = injectUtmDecorationIntoLayout(LAYOUT, resolveConfiguredLanderParams(evil));
    expect(out).not.toContain("</script>");
    expect(paramsOf(clickThrough(evil, "https://lp.example.com/", DEST)).utm_source).toBe(
      "</script><img src=x onerror=alert(1)>",
    );
  });
});
