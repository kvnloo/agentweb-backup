// Default API URL from environment variable or fallback to localhost
const apiBaseUrl = import.meta.env.VITE_API_URL || "http://localhost:3001";

// Discord Invite URL
export const DISCORD_INVITE_URL = "https://discord.gg/kP2u6Wf9KQ";

// Function to build API URLs
export const buildApiUrl = (path: string): string => {
  // Ensure path starts with / for consistent concatenation
  const formattedPath = path.startsWith("/") ? path : `/${path}`;
  return `${apiBaseUrl}${formattedPath}`;
};
