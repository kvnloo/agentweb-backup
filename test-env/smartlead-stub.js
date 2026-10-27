#!/usr/bin/env node
// Fake Smartlead for testing the ENG-673 key flow without a real key.
// Answers GET /api/v1/email-accounts based on the api_key sent. It is OUR GUESS at Smartlead's
// replies, so it proves our handling, not Smartlead's real behaviour.
//
//   key            reply
//   good-<n>       200, n mailboxes (good-0 = empty list), paged 100 at a time by ?offset
//   bad            401
//   forbidden      403
//   limited        429 (with Retry-After: 1)
//   boom           500
//   weird          200 with a non-list body ({"message":"Plan expired!"})
//   slow           hangs 40 s
//   anything else  401
const http = require("http");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 4010);
const PAGE = 100;

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://stub");
    const key = url.searchParams.get("api_key") || "";
    console.log(`${req.method} ${url.pathname} key=${key.slice(0, 12)} offset=${url.searchParams.get("offset")}`);

    if (!url.pathname.endsWith("/email-accounts") || req.method !== "GET") {
      return send(res, 404, { message: "stub: not implemented" });
    }
    if (key === "bad") return send(res, 401, { message: "Invalid API key" });
    if (key === "forbidden") return send(res, 403, { message: "Forbidden" });
    if (key === "limited") return send(res, 429, { message: "Too many requests" }, { "retry-after": "1" });
    if (key === "boom") return send(res, 500, { message: "Internal error" });
    if (key === "weird") return send(res, 200, { message: "Plan expired!" });
    if (key === "slow") return void setTimeout(() => send(res, 200, []), 40000);

    const m = /^good-(\d+)$/.exec(key);
    if (!m) return send(res, 401, { message: "Invalid API key" });
    const total = Number(m[1]);
    const offset = Number(url.searchParams.get("offset") || 0);
    const rows = [];
    for (let i = offset; i < Math.min(total, offset + PAGE); i++) {
      rows.push({ id: 1000 + i, from_email: `box${i + 1}@stub-outreach.test` });
    }
    send(res, 200, rows);
  })
  .listen(PORT, () => console.log(`smartlead stub on :${PORT}`));
