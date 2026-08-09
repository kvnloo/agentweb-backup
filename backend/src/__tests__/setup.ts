// Test setup file
// This file runs before all tests

// Set NODE_ENV to test
process.env.NODE_ENV = 'test';

// Set test environment variables
process.env.AWS_REGION = 'us-west-2';
process.env.AWS_ACCESS_KEY_ID = 'test-access-key';
process.env.AWS_SECRET_ACCESS_KEY = 'test-secret-key';
// Ensure server-based tests bind to an ephemeral port to avoid conflicts
process.env.PORT = process.env.PORT || '0';

// Set Azure OpenAI environment variables for tests (required by OpenAI client initialization)
process.env.AZURE_OPENAI_API_KEY = process.env.AZURE_OPENAI_API_KEY || 'test-api-key';
process.env.AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT || 'https://test.openai.azure.com';
process.env.AZURE_OPENAI_DEPLOYMENT = process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4';
process.env.AZURE_OPENAI_API_VERSION = process.env.AZURE_OPENAI_API_VERSION || '2024-08-01-preview';

// agentModeService.ts/growthGeniusService.ts each fall back to their own hardcoded default
// model id (e.g. 'anthropic.claude-opus-5') only when these are unset — but a local .env
// that still has the literal unfilled '.env.example' placeholder text (a truthy string, e.g.
// "your_azure_openai_deployment_agent_mode") silently defeats that `||` fallback and never
// gets caught by it, causing default_model to resolve to garbage in that dev's own test runs
// as opposed to the real value CI is expected to produce (a clean checkout's local .env may
// not define these keys at all).
//
// Set to '' rather than `delete` — several service files (chatbotService.ts among them, on
// agentModeService.ts's own import path) call `dotenv.config()` again at their own module-load
// time, later than this file runs. dotenv only fills in keys that don't already
// `hasOwnProperty` on process.env, so a deleted key gets silently re-populated from the .env
// file on disk the moment one of those modules loads — an empty string keeps the key present
// (dotenv leaves it alone) while still being falsy for the app's own `|| 'default'` fallback.
process.env.AZURE_OPENAI_DEPLOYMENT_AGENT_MODE = '';
process.env.AZURE_OPENAI_DEPLOYMENT_GROWTH_GENIUS = '';

// Set Azure OpenAI embeddings environment variables for tests
process.env.AZURE_OPENAI_EMBEDDINGS_API_KEY = process.env.AZURE_OPENAI_EMBEDDINGS_API_KEY || 'test-embeddings-api-key';
process.env.AZURE_OPENAI_EMBEDDINGS_ENDPOINT = process.env.AZURE_OPENAI_EMBEDDINGS_ENDPOINT || 'https://test-embeddings.openai.azure.com';
process.env.AZURE_OPENAI_EMBEDDINGS_DEPLOYMENT = process.env.AZURE_OPENAI_EMBEDDINGS_DEPLOYMENT || 'text-embedding-ada-002';

// Set Google OAuth environment variables for tests (required by passport-google-oauth20)
process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'test-google-client-id';
process.env.GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || 'test-google-client-secret';
// Set JWT_SECRET for modules that require it during import (e.g., OAuth state verification)
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

// Suppress console.log during tests unless explicitly needed
const originalConsoleLog = console.log;
console.log = (...args) => {
  // Only log if it's not the environment variables debug message
  if (!args[0]?.includes('Environment variables loaded:')) {
    originalConsoleLog(...args);
  }
};
export {};
