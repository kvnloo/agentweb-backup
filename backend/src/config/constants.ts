// Get table prefix based on NODE_ENV (defaults to empty string for production)
export const TABLE_PREFIX = process.env.NODE_ENV === 'development' ? 'Dev-' : ''; 