// Get the API URL from environment variable or fallback to development URL
export const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

// Helper function to build API endpoints
export const buildApiUrl = (endpoint: string) => `${API_URL}${endpoint.startsWith('/') ? '' : '/'}${endpoint}`; 