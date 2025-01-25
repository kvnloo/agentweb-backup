// Debug mode is true when VITE_DEBUG is not defined or set to true
const DEBUG = import.meta.env.VITE_DEBUG !== 'false';

// Get the API URL from Vite environment variable or fallback to development URL
export const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

if (DEBUG) {
  console.log('Config Debug Info:');
  console.log('DEBUG:', DEBUG);
  console.log('API_URL:', API_URL);
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