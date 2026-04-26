// @ts-nocheck
// Note: Environment variables must be set during build time for Vite.
// For development, we use hardcoded values.
// For production, these values are replaced during the build process with the VITE_* environment variables.

// Debug mode is true when VITE_DEBUG is not defined or set to true
const DEBUG = import.meta.env.VITE_DEBUG !== "false";

// Get the API URL from Vite environment variable or fallback to development URL
export const API_URL = import.meta.env.VITE_API_URL || "http://localhost:3001";

// Get the Customer Frontend URL from Vite environment variable or fallback to production URL
export const CUSTOMER_FRONTEND_URL = import.meta.env.VITE_CUSTOMER_FRONTEND_URL || "http://localhost:5174";

// Discord Invite URL
export const DISCORD_INVITE_URL = "https://discord.gg/kP2u6Wf9KQ";

// Get the list of available LLMs from environment variable or use default list
export const AVAILABLE_LLMS = (
  import.meta.env.VITE_LIST_FULL_LLM_NAMES ||
  "azure->openai->gpt-4.1,google->google->gemini-2.5-pro-preview-05-06,azure->openai->gpt-4o,aws->anthropic->anthropic.claude-3-5-sonnet-20241022-v2:0,openai->openai->gpt-4o,aws->anthropic->us.anthropic.claude-3-7-sonnet-20250219-v1:0,openai->openai->gpt-4o-mini,azure->openai->o1-mini,pld->deepseek->DeepSeek-R1,deepseek->deepseek->deepseek-reasoner,google->google->gemini-2.0-flash,google->google->gemini-2.5-flash,google->google->gemini-2.5-flash-lite,openai->openai->gpt-5,azure->openai->gpt-5-chat,google->google->gemini-2.5-pro,azure->openai->gpt-5.5"
)
  .split(",")
  .map((llm: string) => llm.trim())
  .filter((llm: string) => llm); // Remove empty strings

// Get the list of available LLMs for deep research from environment variable or use default list
export const DEEP_RESEARCH_LLMS = (
  import.meta.env.VITE_DEEP_RESEARCH_LLM_NAMES ||
  "azure->openai->o1-mini,azure->openai->gpt-4o,google->google->gemini-2.0-flash-exp"
)
  .split(",")
  .map((llm: string) => llm.trim())
  .filter((llm: string) => llm); // Remove empty strings


// Function to get the appropriate LLM list based on whether deep research is enabled
export const getLLMsForTask = (isDeepResearch: boolean) => {
  return isDeepResearch ? DEEP_RESEARCH_LLMS : AVAILABLE_LLMS;
};

if (DEBUG) {
  console.log("Config Debug Info:");
  console.log("DEBUG:", DEBUG);
  console.log("API_URL:", API_URL);
  console.log("AVAILABLE_LLMS:", AVAILABLE_LLMS);
  console.log("DEEP_RESEARCH_LLMS:", DEEP_RESEARCH_LLMS);
  console.log("import.meta.env:", import.meta.env);
}

// File upload limits
export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB in bytes

// Helper function to build API endpoints
export const buildApiUrl = (endpoint: string) => {
  const url = `${API_URL}${endpoint.startsWith("/") ? "" : "/"}${endpoint}`;
  if (DEBUG) {
    console.log("buildApiUrl:", { endpoint, url });
  }
  return url;
};
