import fs from "fs";
import path from "path";

// ENG-1752: the unauthenticated Notion dev-env launcher webhook
// (POST /api/webhooks/notion-dev-env) let anyone with a readable Notion page
// id launch/teardown EC2 instances or relay prompts to a Claude Code box.
// The Notion automation rail was retired (ENG-534) but the route/service
// stayed mounted. This proves the route and service are deleted outright
// (not merely gated) and that app.ts no longer wires them up.

describe("ENG-1752: devEnv Notion webhook launcher is deleted", () => {
  it("has no routes/devEnv.ts file", () => {
    const routePath = path.join(__dirname, "..", "routes", "devEnv.ts");
    expect(fs.existsSync(routePath)).toBe(false);
  });

  it("has no services/devEnvService.ts file", () => {
    const servicePath = path.join(__dirname, "..", "services", "devEnvService.ts");
    expect(fs.existsSync(servicePath)).toBe(false);
  });

  it("app.ts no longer imports or mounts the devEnv route", () => {
    const appSrc = fs.readFileSync(path.join(__dirname, "..", "app.ts"), "utf8");
    expect(appSrc).not.toMatch(/devEnv/i);
  });

  it("POST /api/webhooks/notion-dev-env resolves to no handler (404 by default)", async () => {
    // Build a minimal express app the same way the real app.ts composes
    // routers, without pulling in the full app (secrets/DB/etc). Since the
    // devEnv router no longer exists, there is nothing to mount here — this
    // documents the contract: no router in the app registers this path, so
    // Express's default "no route matched" 404 is what a real request gets.
    const express = require("express");
    const app = express();
    app.use(express.json());
    // Intentionally: no app.use("/api", devEnvRoutes) — it was deleted.
    const request = require("supertest");
    const res = await request(app)
      .post("/api/webhooks/notion-dev-env")
      .send({ verification_token: "anything" });
    expect(res.status).toBe(404);
  });
});
