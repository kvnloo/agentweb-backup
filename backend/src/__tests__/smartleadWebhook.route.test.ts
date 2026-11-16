/**
 * The public Smartlead event endpoint (ENG-673, slice 3): token first, then parse, then the service. What matters here: a bad token gets
 * nothing, events we cannot act on are acknowledged (so Smartlead does not retry them), a failure that a retry could fix is a 5xx, the push
 * kill switch is NOT consulted (an opt-out must always get through), and no message content reaches the logs.
 */
import request from "supertest";
import express from "express";

const mockHandle = jest.fn();
jest.mock("../services/smartleadEventRuntime", () => ({ getSmartleadEventService: () => ({ handle: mockHandle }) }));
jest.mock("../config/jwt", () => ({ getJwtSecret: () => "route-test-secret" }));

import smartleadWebhookRouter, { smartleadWebhookPreParse } from "../routes/smartleadWebhook";
import { signWebhookToken } from "../services/smartleadWebhookToken";

const app = express();
// the same chain app.ts mounts before the global body parsers
app.use("/api/webhooks/smartlead", ...smartleadWebhookPreParse);
app.use("/api/webhooks/smartlead", smartleadWebhookRouter);

const ACCOUNT = "smartlead-u1";
const url = (campaign: number | string = 77, token = signWebhookToken("route-test-secret", ACCOUNT, campaign)) => `/api/webhooks/smartlead/${ACCOUNT}/${campaign}/${token}`;
const send = (path: string, body: unknown) => request(app).post(path).set("content-type", "application/json").send(typeof body === "string" ? body : JSON.stringify(body));

describe("POST /api/webhooks/smartlead/:accountId/:campaignId/:token", () => {
  let logs: string[];
  beforeEach(() => {
    mockHandle.mockReset();
    mockHandle.mockResolvedValue({ matched: 1, changed: 1, duplicates: 0 });
    logs = [];
    jest.spyOn(console, "log").mockImplementation((...a) => { logs.push(a.join(" ")); });
    jest.spyOn(console, "warn").mockImplementation((...a) => { logs.push(a.join(" ")); });
    jest.spyOn(console, "error").mockImplementation((...a) => { logs.push(a.join(" ")); });
    delete process.env.SMARTLEAD_PUSH_ENABLED;
    delete process.env.SMARTLEAD_WEBHOOK_LOG_BODY;
  });
  afterEach(() => jest.restoreAllMocks());

  const reply = { event_type: "EMAIL_REPLY", campaign_id: 77, from_email: "ann@example.com", to_email: "us@ours.com", subject: "Re: SECRET SUBJECT", reply_body: "PRIVATE TEXT", time_replied: "2026-10-29T11:00:00Z" };

  it("a bad token, the wrong campaign for a token, or an odd campaign id is a bare 404 and the service is never reached", async () => {
    for (const path of [url(77, "nope"), url(77, signWebhookToken("route-test-secret", ACCOUNT, 78)), url(77, signWebhookToken("other-secret", ACCOUNT, 77)), `/api/webhooks/smartlead/${ACCOUNT}/abc/${signWebhookToken("route-test-secret", ACCOUNT, "abc")}`, `/api/webhooks/smartlead/${ACCOUNT}/1e3/x`]) {
      const res = await send(path, reply);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({});
    }
    expect(mockHandle).not.toHaveBeenCalled();
  });

  it("a good token hands the parsed event to the service, with the campaign as a number", async () => {
    const res = await send(url(), reply);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, matched: 1, changed: 1, duplicates: 0 });
    expect(mockHandle).toHaveBeenCalledTimes(1);
    const [ctx, event] = mockHandle.mock.calls[0];
    expect(ctx).toEqual({ accountId: ACCOUNT, campaignId: 77 });
    expect(event).toMatchObject({ kind: "reply", campaignId: 77, subject: "Re: SECRET SUBJECT" });
  });

  it("works with the push kill switch OFF: an opt-out must always reach the CRM", async () => {
    expect(process.env.SMARTLEAD_PUSH_ENABLED).toBeUndefined();
    const res = await send(url(), { event_type: "LEAD_UNSUBSCRIBED", campaign_id: 77, lead_email: "ann@example.com" });
    expect(res.status).toBe(200);
    expect(mockHandle).toHaveBeenCalledTimes(1);
  });

  it("acknowledges what it will not act on with a 200 and a reason, so Smartlead does not retry it", async () => {
    for (const [body, reason] of [[{ event_type: "EMAIL_SENT", campaign_id: 77 }, "unhandled_event"], [{ event_type: "EMAIL_REPLY" }, "no_campaign"], [{ event_type: "EMAIL_REPLY", campaign_id: 77 }, "no_contact_address"], ["not json {", "bad_json"], ["[1,2]", "not_an_object"]] as const) {
      const res = await send(url(), body);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, ignored: reason });
    }
    expect(mockHandle).not.toHaveBeenCalled();
  });

  it("a failure a retry can fix is a 5xx with no detail", async () => {
    mockHandle.mockRejectedValue(new Error("dynamo exploded with secret table name"));
    const res = await send(url(), reply);
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain("dynamo");
  });

  it("never logs message content: only ids, the kind, counts and field names", async () => {
    await send(url(), reply);
    await send(url(), { event_type: "EMAIL_SENT", campaign_id: 77, subject: "ANOTHER SECRET" });
    const all = logs.join("\n");
    expect(all).toContain("[SmartleadWebhook]");
    expect(all).toMatch(/kind=reply campaign=77|campaign=77 kind=reply/);
    for (const secret of ["SECRET SUBJECT", "PRIVATE TEXT", "ann@example.com", "ANOTHER SECRET"]) expect(all).not.toContain(secret);
    expect(all).toContain("keys=event_type,campaign_id"); // what a payload carries is logged; what it says is not
  });

  it("logs the body only when a test environment turns that on, and never in production", async () => {
    process.env.SMARTLEAD_WEBHOOK_LOG_BODY = "true";
    await send(url(), { ...reply, secret_key: "HOOKSECRET", webhook_url: "http://x/TOKENINURL" });
    const logged = logs.join("\n");
    expect(logged).toContain("SECRET SUBJECT"); // the field names and the ordinary values are there to learn from
    for (const never of ["PRIVATE TEXT", "HOOKSECRET", "TOKENINURL"]) expect(logged).not.toContain(never); // but not secrets or reply text
    logs.length = 0;
    const before = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await send(url(), reply);
      expect(logs.join("\n")).not.toContain("PRIVATE TEXT");
    } finally {
      process.env.NODE_ENV = before;
    }
  });

  it("an oversize or malformed body from a caller WITHOUT a valid token is a bare 404, before the body is read (no 500, nothing reaches the app's error handler)", async () => {
    const big = JSON.stringify({ event_type: "EMAIL_REPLY", campaign_id: 77, pad: "x".repeat(300 * 1024) });
    const res = await send(url(77, "nope"), big);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({});
    expect(mockHandle).not.toHaveBeenCalled();
    const odd = await request(app).post(url(77, "nope")).set("content-type", "application/json").set("content-encoding", "gzip").send("not gzip");
    expect(odd.status).toBe(404);
  });

  it("an oversize body WITH a valid token is a bare 413 from the route itself", async () => {
    const big = JSON.stringify({ event_type: "EMAIL_REPLY", campaign_id: 77, pad: "x".repeat(300 * 1024) });
    const res = await send(url(), big);
    expect(res.status).toBe(413);
    expect(res.body).toEqual({});
    expect(mockHandle).not.toHaveBeenCalled();
  });

  it("only POST with a well-formed path and a valid token gets through; anything else is a bare 404", async () => {
    expect((await request(app).get(url())).status).toBe(404);
    expect((await send(`/api/webhooks/smartlead/${ACCOUNT}/77`, reply)).status).toBe(404);
    expect((await send(`/api/webhooks/smartlead/${ACCOUNT}/77/${signWebhookToken("route-test-secret", ACCOUNT, 77)}/extra`, reply)).status).toBe(404);
    expect(mockHandle).not.toHaveBeenCalled();
  });

  it("accepts a token made with the dedicated secret when one is set", async () => {
    process.env.SMARTLEAD_WEBHOOK_SECRET = "dedicated";
    try {
      expect((await send(url(), reply)).status).toBe(404); // the JWT-secret token no longer works
      expect((await send(url(77, signWebhookToken("dedicated", ACCOUNT, 77)), reply)).status).toBe(200);
    } finally {
      delete process.env.SMARTLEAD_WEBHOOK_SECRET;
    }
  });
});
