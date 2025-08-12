// Default API URL from environment variable or fallback to localhost
const apiBaseUrl = import.meta.env.VITE_API_URL || "http://localhost:3001";

// Partner Portal URL from environment variable or fallback to localhost
const partnerPortalUrl = import.meta.env.VITE_PARTNER_PORTAL_URL || "http://localhost:5173";

// Discord Invite URL
export const DISCORD_INVITE_URL = "https://discord.gg/kP2u6Wf9KQ";

// File upload limits
export const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB in bytes

// Function to build API URLs
export const buildApiUrl = (path: string): string => {
  // Ensure path starts with / for consistent concatenation
  const formattedPath = path.startsWith("/") ? path : `/${path}`;
  return `${apiBaseUrl}${formattedPath}`;
};

// Function to build Partner Portal URLs
export const buildPartnerPortalUrl = (path: string): string => {
  // Ensure path starts with / for consistent concatenation
  const formattedPath = path.startsWith("/") ? path : `/${path}`;
  return `${partnerPortalUrl}${formattedPath}`;
};
