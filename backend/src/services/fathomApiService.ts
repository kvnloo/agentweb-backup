/**
 * Thin wrapper around Fathom's REST API.
 * Used for webhook registration/deletion and API key validation.
 *
 * @see https://fathom.video/api
 */

const FATHOM_API_BASE = 'https://api.fathom.ai/external/v1';

export class FathomApiService {
  constructor(private apiKey: string) {}

  /**
   * Register our webhook to receive meeting data from Fathom.
   *
   * @param destinationUrl - The URL Fathom will POST meeting payloads to
   * @returns The webhook ID from Fathom
   */
  async registerWebhook(destinationUrl: string): Promise<{ id: string }> {
    const response = await fetch(`${FATHOM_API_BASE}/webhooks`, {
      method: 'POST',
      headers: {
        'X-Api-Key': this.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        destination_url: destinationUrl,
        triggered_for: ['my_recordings', 'shared_team_recordings'],
        include_transcript: true,
        include_summary: true,
        include_action_items: true,
        include_crm_matches: true,
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to register Fathom webhook: ${response.status}`);
    }

    return response.json();
  }

  /**
   * Delete a previously registered webhook.
   *
   * @param webhookId - The ID of the webhook to delete
   */
  async deleteWebhook(webhookId: string): Promise<void> {
    const response = await fetch(`${FATHOM_API_BASE}/webhooks/${webhookId}`, {
      method: 'DELETE',
      headers: {
        'X-Api-Key': this.apiKey,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to delete Fathom webhook: ${response.status}`);
    }
  }

  /**
   * Validate the API key by hitting the teams endpoint.
   *
   * @returns true if the key is valid (200), false otherwise
   */
  async validateApiKey(): Promise<boolean> {
    try {
      const response = await fetch(`${FATHOM_API_BASE}/teams`, {
        method: 'GET',
        headers: {
          'X-Api-Key': this.apiKey,
          'Content-Type': 'application/json',
        },
      });

      return response.ok;
    } catch {
      return false;
    }
  }
}
