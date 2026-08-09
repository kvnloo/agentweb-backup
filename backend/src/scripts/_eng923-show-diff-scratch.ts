import "../config/aws";
import { buildLandingPageMiddleware, buildCaptureRoute, getLandingPagesByOwner } from "../services/v0Service";
import { buildListByPathForRepo, resolveRootRecord } from "./backfill-eng923-attribution-repos";
import { getGitHubOrgToken } from "../utils/secretsManager";
import axios from "axios";

const REPO = "AgentWebPro/lp-free-ai-seo-geo-audit-37343865";
const OWNER = "4e29ce4e-8661-45bd-9881-3075d9a76971";

async function readRepoFile(repo: string, path: string, headers: any): Promise<string | null> {
  try {
    const { data } = await axios.get<any>(`https://api.github.com/repos/${repo}/contents/${path}`, { headers });
    return Buffer.from(data.content, "base64").toString("utf-8");
  } catch (e: any) {
    if (e?.response?.status === 404) return null;
    throw e;
  }
}

async function main() {
  const { token } = await getGitHubOrgToken();
  console.log("GitHub org token fetched OK (length", token.length, ")");
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3+json" };

  const listByPath = await buildListByPathForRepo(OWNER, REPO);
  const pages = await getLandingPagesByOwner(OWNER);
  const root = resolveRootRecord(pages, REPO);

  const newMiddleware = buildLandingPageMiddleware();
  const newCapture = buildCaptureRoute(listByPath, undefined, root?.metaPixelId, root?.metaAdAccountId);

  const curMiddleware = await readRepoFile(REPO, "middleware.ts", headers);
  const curCapture = await readRepoFile(REPO, "app/api/capture/route.ts", headers);

  console.log("=== listByPath that would be baked in ===");
  console.log(JSON.stringify(listByPath, null, 2));
  console.log("\n=== resolved pixel/account ===", { pixelId: root?.metaPixelId, accountId: root?.metaAdAccountId });
  console.log("\n=== middleware.ts ===");
  console.log(curMiddleware === null ? "CURRENTLY: does not exist -> WOULD BE CREATED" : (curMiddleware === newMiddleware ? "IDENTICAL, no change" : "WOULD BE REPLACED (differs)"));
  console.log("\n=== app/api/capture/route.ts ===");
  console.log(curCapture === newCapture ? "IDENTICAL, no change" : "WOULD BE REPLACED");
  console.log("--- current (full) ---");
  console.log(curCapture ?? "(missing)");
  console.log("--- new (first 600 chars) ---");
  console.log(newCapture.slice(0, 600));
}
main().catch((e) => { console.error(e); process.exit(1); });
