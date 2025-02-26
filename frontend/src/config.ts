// Note: Environment variables must be set during build time for Vite.
// For development, we use hardcoded values.
// For production, these values are replaced during the build process with the VITE_* environment variables.

// Debug mode is true when VITE_DEBUG is not defined or set to true
const DEBUG = import.meta.env.VITE_DEBUG !== 'false';

// Get the API URL from Vite environment variable or fallback to development URL
export const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

// Get the list of available LLMs from environment variable or use default list
export const AVAILABLE_LLMS = (import.meta.env.VITE_LIST_FULL_LLM_NAMES || 'azure->openai->gpt-4o,aws->anthropic->anthropic.claude-3-5-sonnet-20241022-v2:0,openai->openai->gpt-4o,aws->anthropic->us.anthropic.claude-3-7-sonnet-20250219-v1:0')
  .split(',')
  .map((llm: string) => llm.trim())
  .filter((llm: string) => llm); // Remove empty strings

if (DEBUG) {
  console.log('Config Debug Info:');
  console.log('DEBUG:', DEBUG);
  console.log('API_URL:', API_URL);
  console.log('AVAILABLE_LLMS:', AVAILABLE_LLMS);
  console.log('import.meta.env:', import.meta.env);
}

// Helper function to build API endpoints
export const buildApiUrl = (endpoint: string) => {
  const url = `${API_URL}${endpoint.startsWith('/') ? '' : '/'}${endpoint}`;
  if (DEBUG) {
    console.log('buildApiUrl:', { endpoint, url });
  }
  return url;
}; 