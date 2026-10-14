// Get table prefix based on NODE_ENV (defaults to empty string for production)
export const TABLE_PREFIX = process.env.NODE_ENV === 'development' ? 'Dev-' : '';

/** Environment-qualified DynamoDB table name. New code should build table names through this. */
export const tableName = (base: string): string => `${TABLE_PREFIX}${base}`;
