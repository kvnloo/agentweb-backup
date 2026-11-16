import {
  runCrossTenantDomainProbe,
  DEFAULT_PROBE_DOMAIN,
} from "../verification/crossTenantDomainProbe";

const env = {
  XTENANT_API_BASE: "https://api.example.test/",
  XTENANT_B_TOKEN: "tok-b",
  XTENANT_A_VERCEL_PROJECT_ID: "prj_A",
};

const respond = (status: number) => jest.fn().mockResolvedValue({ status });

describe("crossTenantDomainProbe (ENG-2411)", () => {
  it("PASSes on 403 and sends B's token against A's project", async () => {
    const f = respond(403);
    const r = await runCrossTenantDomainProbe(env, f);
    expect(r.verdict).toBe("PASS");
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://api.example.test/api/domains/custom");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer tok-b");
    expect(JSON.parse(init.body)).toEqual({ vercelProjectId: "prj_A", domain: DEFAULT_PROBE_DOMAIN });
  });

  it.each([200, 201, 204])("FAILs on %i (cross-tenant write accepted)", async (s) => {
    const r = await runCrossTenantDomainProbe(env, respond(s));
    expect(r.verdict).toBe("FAIL");
    expect(r.reason).toMatch(/CROSS-TENANT WRITE/);
  });

  it.each([401, 404, 500])("FAILs on unexpected %i rather than passing", async (s) => {
    expect((await runCrossTenantDomainProbe(env, respond(s))).verdict).toBe("FAIL");
  });

  it.each(["XTENANT_API_BASE", "XTENANT_B_TOKEN", "XTENANT_A_VERCEL_PROJECT_ID"])(
    "SKIPs (never PASS) and makes no request when %s is missing",
    async (key) => {
      const f = respond(403);
      const r = await runCrossTenantDomainProbe({ ...env, [key]: "  " }, f);
      expect(r.verdict).toBe("SKIP");
      expect(r.reason).toContain(key);
      expect(f).not.toHaveBeenCalled();
    }
  );
});
