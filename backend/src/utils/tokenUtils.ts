/**
 * Token validation utilities for connected accounts
 */

export type TokenStatus = 'active' | 'expiring_soon' | 'expired' | 'disconnected';

/**
 * Get the status of a token based on its expiry time
 * @param expiresAt - Token expiry timestamp in milliseconds
 * @returns TokenStatus
 */
export function getTokenStatus(expiresAt: number): TokenStatus {
  const now = Date.now();
  const sevenDays = 7 * 24 * 60 * 60 * 1000;

  if (expiresAt < now) {
    return 'expired';
  }
  if (expiresAt < now + sevenDays) {
    return 'expiring_soon';
  }
  return 'active';
}

/**
 * Format a human-readable expiry message
 * @param expiresAt - Token expiry timestamp in milliseconds
 * @returns Human-readable string like "Expires in 5 days"
 */
export function formatExpiryMessage(expiresAt: number): string {
  const now = Date.now();
  const diffMs = expiresAt - now;

  if (diffMs < 0) {
    return 'Expired';
  }

  const days = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  if (days > 0) {
    return `Expires in ${days} day${days > 1 ? 's' : ''}`;
  }

  const hours = Math.floor(diffMs / (60 * 60 * 1000));
  if (hours > 0) {
    return `Expires in ${hours} hour${hours > 1 ? 's' : ''}`;
  }

  const minutes = Math.floor((diffMs + 500) / (60 * 1000));
  // If we're very close to the 1 hour boundary, rounding can produce 60 minutes.
  // Prefer showing "1 hour" to avoid flaky output around the boundary.
  if (minutes >= 60) {
    return 'Expires in 1 hour';
  }
  return `Expires in ${minutes} minute${minutes > 1 ? 's' : ''}`;
}
