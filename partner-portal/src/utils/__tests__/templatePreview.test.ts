import { buildPreviewSrcDoc, getPreviewBaseHref } from "../templatePreview";

describe("templatePreview utils", () => {
  it("returns origin-based base href from window location", () => {
    expect(getPreviewBaseHref()).toBe("http://localhost/");
  });

  it("builds a full preview document for HTML fragments", () => {
    const srcDoc = buildPreviewSrcDoc(
      { html_content: "<div>Hello</div>" },
      { baseHref: "https://cdn.example.com/" }
    );

    expect(srcDoc).toContain("<!DOCTYPE html>");
    expect(srcDoc).toContain('http-equiv="Content-Security-Policy"');
    expect(srcDoc).toContain('<base href="https://cdn.example.com/">');
    expect(srcDoc).toContain("<div>Hello</div>");
  });

  it("injects CSP into full-document HTML without existing CSP", () => {
    const srcDoc = buildPreviewSrcDoc(
      { html_content: "<!DOCTYPE html><html><head><title>X</title></head><body>Hi</body></html>" },
      { baseHref: "https://assets.example.com/" }
    );

    expect(srcDoc).toContain('http-equiv="Content-Security-Policy"');
    expect(srcDoc).toContain('<base href="https://assets.example.com/">');
    expect(srcDoc).toContain("<body>Hi</body>");
  });

  it("does not duplicate CSP meta when already present", () => {
    const withCsp = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta http-equiv="Content-Security-Policy" content="default-src 'self'">
      </head>
      <body>Safe</body>
      </html>
    `;

    const srcDoc = buildPreviewSrcDoc({ html_content: withCsp });
    const cspMatches = srcDoc.match(/http-equiv="Content-Security-Policy"/g) || [];
    expect(cspMatches).toHaveLength(1);
  });

  it("removes script tags with javascript: src", () => {
    const srcDoc = buildPreviewSrcDoc({
      html_content: `<html><head></head><body><script src="javascript:alert(1)"></script><p>ok</p></body></html>`,
    });

    expect(srcDoc).not.toContain("javascript:alert(1)");
    expect(srcDoc).toContain("<p>ok</p>");
  });
});
