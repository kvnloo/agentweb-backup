/**
 * AC#3 regression — brand-build scrape returns the CURRENT site (no stale
 * cache reuse), proven end-to-end against a REAL changing fixture site.
 *
 * The onboarding stale-scrape reports (Vivian's agent scraped an old version
 * of her site) motivated the no-cache scrape work. The sibling
 * `cssExtractor.test.ts` asserts the request opts out of caches with a MOCKED
 * axios; this test closes the fetch-layer acceptance criterion literally: it
 * stands up a real HTTP server, fetches it with the REAL http client, MUTATES
 * the served content, fetches again, and asserts the second response reflects
 * the new content — a stale cache would return the first version twice.
 *
 * The stale-cache risk lives entirely at the fetch layer, so axios is REAL
 * here (unlike the sibling suite). The test calls that same production fetch
 * boundary directly so its loopback fixture does not need to bypass the
 * extractor's SSRF validation.
 */
import http from "http";
import type { AddressInfo } from "net";

// Mock color (ESM) so cssExtractor is loadable.
jest.mock("color", () => {
  const Color = (value: string) => {
    const v = value.trim().toLowerCase();
    const hex = v.startsWith("#")
      ? v.length === 4
        ? `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`
        : v
      : "#000000";
    return { hex: () => hex, lightness: () => 50 };
  };
  Color.default = Color;
  return { __esModule: true, default: Color };
});

// Mock jsdom with a lightweight regex parser (its real transitive TS deps
// don't transform under ts-jest). Returns the minimum the extractor reads.
jest.mock("jsdom", () => ({
  JSDOM: jest.fn().mockImplementation((html: string) => {
    const styles: Array<{ textContent: string }> = [];
    const styleRe = /<style[^>]*>([\s\S]*?)<\/style>/gi;
    let m: RegExpExecArray | null;
    while ((m = styleRe.exec(html)) !== null) styles.push({ textContent: m[1] });
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const titleText = titleMatch?.[1]?.trim() || null;
    return {
      window: {
        document: {
          querySelector: (sel: string) =>
            sel === "title" && titleText ? { textContent: titleText } : null,
          querySelectorAll: (sel: string) => (sel === "style" ? styles : []),
        },
      },
    };
  }),
}));

jest.mock("@projectwallace/css-analyzer", () => ({ analyze: jest.fn() }));

import { fetchFreshHtmlFromValidatedUrl } from "../services/cssExtractor";

function page(version: string, color: string): string {
  return `<!DOCTYPE html>
<html>
  <head>
    <title>ACME ${version}</title>
    <style>:root { --brand-primary: ${color}; } body { color: ${color}; }</style>
  </head>
  <body><h1>ACME ${version}</h1><p>marker-${version}</p></body>
</html>`;
}

describe("cssExtractor — fresh changing-fixture scrape (AC#3)", () => {
  let server: http.Server;
  let baseUrl: string;
  let currentHtml = page("V1", "#112233");
  const requestHeaders: Array<http.IncomingHttpHeaders> = [];
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      requestHeaders.push(req.headers);
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(currentHtml);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        const { port } = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${port}/`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("scrapes the CURRENT content on every call — a changed fixture yields the new version, not a stale copy", async () => {
    // First scrape sees V1.
    currentHtml = page("V1", "#112233");
    const first = await fetchFreshHtmlFromValidatedUrl(baseUrl);
    expect(first).toContain("marker-V1");
    expect(first).toContain("#112233");
    expect(first).not.toContain("marker-V2");

    // Site changes underneath us.
    currentHtml = page("V2", "#ff8800");

    // Second scrape must reflect V2 — proving no stale-cache reuse.
    const second = await fetchFreshHtmlFromValidatedUrl(baseUrl);
    expect(second).toContain("marker-V2");
    expect(second).toContain("#ff8800");
    expect(second).not.toContain("marker-V1");
  });

  it("opts every scrape request out of intermediary caches (no-cache headers on the wire)", async () => {
    requestHeaders.length = 0;
    currentHtml = page("V3", "#00aa55");
    await fetchFreshHtmlFromValidatedUrl(baseUrl);

    const scrapeReq = requestHeaders.find(
      (h) => h["cache-control"] !== undefined
    );
    expect(scrapeReq).toBeDefined();
    expect(scrapeReq!["cache-control"]).toBe("no-cache");
    expect(scrapeReq!["pragma"]).toBe("no-cache");
  });
});
