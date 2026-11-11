import { matchesProductFilter, productPills, signupTooltip } from "../productBadges";

describe("productPills (ENG-2906)", () => {
  it("shows a Zoma pill for products.zoma or signupProduct zoma", () => {
    expect(productPills({ products: { zoma: { firstAt: "a", lastAt: "b" } } }).map((p) => p.product)).toEqual(["zoma"]);
    expect(productPills({ signupProduct: "zoma" }).map((p) => p.product)).toEqual(["zoma"]);
  });

  it("shows an Emma MCP pill alongside Zoma; never a pill for web-only or unattributed users", () => {
    expect(productPills({ signupProduct: "zoma", products: { emma_mcp: { firstAt: "a", lastAt: "b" } } }).map((p) => p.product)).toEqual(["zoma", "emma_mcp"]);
    expect(productPills({ signupProduct: "emma_web", products: { emma_web: { firstAt: "a", lastAt: "b" } } })).toEqual([]);
    expect(productPills({})).toEqual([]);
    expect(productPills(null)).toEqual([]);
  });

  it("ignores malformed products values", () => {
    expect(productPills({ products: "zoma" as any })).toEqual([]);
    expect(productPills({ products: ["zoma"] as any })).toEqual([]);
  });
});

describe("signupTooltip", () => {
  it("joins product, client and ref, and marks inferred confidence", () => {
    expect(signupTooltip({ signupProduct: "zoma", signupClient: "claude_code", signupRef: "hn", attributionConfidence: "inferred" })).toBe(
      "Signed up via Zoma · claude_code · ref hn (inferred)",
    );
  });

  it("omits missing parts and does not mark tracked attribution", () => {
    expect(signupTooltip({ signupProduct: "emma_mcp", attributionConfidence: "tracked" })).toBe("Signed up via Emma MCP");
  });

  it("explains a pill with no signup attribution", () => {
    expect(signupTooltip({ products: { zoma: {} } })).toBe("Signup product not recorded");
  });
});

describe("matchesProductFilter", () => {
  const zoma = { signupProduct: "zoma" };
  const mcp = { products: { emma_mcp: { firstAt: "a", lastAt: "b" } } };
  const web = { signupProduct: "emma_web" };
  const none = {};
  it("all keeps everyone; each product keeps signup or products matches", () => {
    expect([zoma, mcp, web, none].filter((u) => matchesProductFilter(u, "all"))).toHaveLength(4);
    expect([zoma, mcp, web, none].filter((u) => matchesProductFilter(u, "zoma"))).toEqual([zoma]);
    expect([zoma, mcp, web, none].filter((u) => matchesProductFilter(u, "emma_mcp"))).toEqual([mcp]);
    expect([zoma, mcp, web, none].filter((u) => matchesProductFilter(u, "emma_web"))).toEqual([web]);
  });
});
