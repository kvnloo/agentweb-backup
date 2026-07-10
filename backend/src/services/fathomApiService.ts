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
        'Authorization': `Bearer ${this.apiKey}`,
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
        'Authorization': `Bearer ${this.apiKey}`,
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
   * Returns false only on definitive auth failures (401/403).
   * Network errors, timeouts, and 5xx responses return null (uncertain)
   * so the caller can fall back to stored token status rather than
   * falsely showing the account as disconnected.
   *
   * @returns true if connected, false if credentials rejected, null if uncertain
   */
  async validateApiKey(): Promise<boolean | null> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      try {
        const response = await fetch(`${FATHOM_API_BASE}/teams`, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          signal: controller.signal,
        });
        if (response.ok) return true;
        if (response.status === 401 || response.status === 403) return false;
        return null; // 5xx or other — uncertain, don't penalise
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      return null; // network error or timeout — uncertain
    }
  }

  async getRecordingSummary(recordingId: string): Promise<any> {
    const response = await fetch(`${FATHOM_API_BASE}/recordings/${encodeURIComponent(recordingId)}/summary`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch Fathom recording summary ${recordingId}: ${response.status}`);
    }

    return response.json();
  }

  async getTranscript(recordingId: string): Promise<any[]> {
    const response = await fetch(`${FATHOM_API_BASE}/recordings/${encodeURIComponent(recordingId)}/transcript`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch Fathom transcript ${recordingId}: ${response.status}`);
    }

    const data = await response.json();
    return Array.isArray(data?.transcript) ? data.transcript : [];
  }
}
