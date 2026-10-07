// Sends AgentWeb's model calls (OpenRouter, OpenAI, Gemini) to the LLM twin (LLM_TWIN_URL), without
// changing the app. Patches exactly the clients AgentWeb uses, and throws if one can't be patched,
// so a call never quietly goes to the real provider. NODE_OPTIONS="--require /opslane/llm-twin.cjs".
const twin = process.env.LLM_TWIN_URL;
if (!twin) throw new Error("llm-twin.cjs: LLM_TWIN_URL is unset (is `llm` in services?)");
const HOSTS = /^https:\/\/(openrouter\.ai|api\.openai\.com|generativelanguage\.googleapis\.com)(?=[/?]|$)/;
const redirect = (url) => url.replace(HOSTS, twin.replace(/\/$/, ""));
// openai v4 builds every request URL here, whatever fetch it then uses.
const { APIClient } = require(require.resolve("openai/core", { paths: [process.cwd(), "/app"] }));
const buildURL = APIClient.prototype.buildURL;
if (typeof buildURL !== "function") throw new Error("llm-twin.cjs: openai's APIClient.buildURL is gone; update the preload");
APIClient.prototype.buildURL = function (...args) { return redirect(buildURL.apply(this, args)); };
// Gemini's SDK and plain calls use the global fetch.
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  if (typeof input === "string" || input instanceof URL) return realFetch(redirect(String(input)), init);
  if (input && typeof input.url === "string" && HOSTS.test(input.url)) return realFetch(new Request(redirect(input.url), input), init);
  return realFetch(input, init);
};
console.error(`[opslane] model calls -> ${twin}`);
