import { UnipileClient } from 'unipile-node-sdk';
import { getUnipileCredentials } from '../utils/secretsManager';

export class LinkedInOutreachService {
  private static instance: UnipileClient | null = null;

  /**
   * Get the normalized API URL (DSN) from credentials.
   */
  public static async getApiUrl(): Promise<string> {
    const { dsn: rawDsn } = await getUnipileCredentials();
    return rawDsn.startsWith('http://') || rawDsn.startsWith('https://')
      ? rawDsn
      : `https://${rawDsn}`;
  }

  /**
   * Get an initialized UnipileClient instance.
   * Credentials are fetched from Secrets Manager.
   */
  public static async getClient(): Promise<UnipileClient> {
    const { apiKey } = await getUnipileCredentials();
    const dsn = await this.getApiUrl();
    return new UnipileClient(dsn, apiKey);
  }

  /**
   * Delete an account from Unipile.
   * @param accountId - The Unipile account ID to delete.
   */
  public static async deleteAccount(accountId: string): Promise<void> {
    try {
      const client = await this.getClient();
      await client.account.delete(accountId);
      console.log(`[LinkedInOutreachService] Successfully deleted account: ${accountId}`);
    } catch (error: any) {
      console.error(`[LinkedInOutreachService] Error deleting account ${accountId}:`, error.message);
      // We throw the error so the caller can decide whether to fail or continue
      throw error;
    }
  }

  /**
   * Fetch one account from Unipile.
   * @param accountId - The Unipile account ID to fetch.
   */
  public static async getAccount(accountId: string) {
    const client = await this.getClient();
    return await client.account.getOne(accountId);
  }
}
