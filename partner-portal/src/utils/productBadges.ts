/**
 * ENG-2906: product attribution for the admin Users page. The backend (`GET /api/admin/users`)
 * returns signupProduct / products / signupClient / signupRef / attributionConfidence; product is
 * attribution only. Zoma and Emma MCP get a pill; Emma web is the default and gets none.
 */
export type ProductFilter = "all" | "zoma" | "emma_mcp" | "emma_web";

export interface ProductAttribution {
  signupProduct?: string;
  signupClient?: string;
  signupRef?: string;
  attributionConfidence?: string;
  products?: Record<string, unknown>;
}

export const PRODUCT_LABELS: Record<string, string> = { zoma: "Zoma", emma_mcp: "Emma MCP", emma_web: "Emma web" };

export function userHasProduct(user: ProductAttribution | null | undefined, product: string): boolean {
  if (!user) return false;
  if (user.signupProduct === product) return true;
  const products = user.products;
  return !!products && typeof products === "object" && !Array.isArray(products) && Object.prototype.hasOwnProperty.call(products, product);
}

export interface ProductPill {
  product: "zoma" | "emma_mcp";
  label: string;
}

export function productPills(user: ProductAttribution | null | undefined): ProductPill[] {
  return (["zoma", "emma_mcp"] as const).filter((p) => userHasProduct(user, p)).map((product) => ({ product, label: PRODUCT_LABELS[product] }));
}

/** "Signed up via <product> · <client> · ref <ref>", suffixed "(inferred)" for inferred attribution. */
export function signupTooltip(user: ProductAttribution | null | undefined): string {
  if (!user?.signupProduct) return "Signup product not recorded";
  const parts = [`Signed up via ${PRODUCT_LABELS[user.signupProduct] ?? user.signupProduct}`];
  if (user.signupClient) parts.push(user.signupClient);
  if (user.signupRef) parts.push(`ref ${user.signupRef}`);
  return parts.join(" · ") + (user.attributionConfidence === "inferred" ? " (inferred)" : "");
}

export function matchesProductFilter(user: ProductAttribution | null | undefined, filter: ProductFilter): boolean {
  return filter === "all" || userHasProduct(user, filter);
}
