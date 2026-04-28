import { dynamodb } from '../config/aws';
import { ResendWebhookEvent } from './webhookService';
const TABLE_PREFIX = process.env.NODE_ENV === 'development' ? 'Dev-' : '';
const TABLE_NAME = `${TABLE_PREFIX}AW-EmailEvents`;

export interface EmailEvent {
  eventId: string;
  emailId: string;
  emailDomain: string;
  eventType: string;
  createdAt: string;
  data: ResendWebhookEvent['data'];
  processedAt: string;
  leadEmail?: string; // Optional, extracted based on event type
  emailContent?: {
    html?: string;
    text?: string;
    headers?: Record<string, string>;
  }; // Optional, cached email content (truncated to 10k chars if needed)
}

class EmailEventsDb {
  /**
   * Extract email address from email string
   * Handles formats like "Name <email@domain.com>" or "email@domain.com"
   */
  private extractEmailAddress(email: string): string {
    // Extract email from "Name <email@domain.com>" format
    const match = email.match(/<([^>]+)>/);
    if (match) {
      return match[1].toLowerCase().trim();
    }
    
    // If no angle brackets, assume the whole string is an email
    return email.split(' ').pop()?.toLowerCase().trim() || email.toLowerCase().trim();
  }

  /**
   * Extract leadEmail from event data based on event type
   */
  private extractLeadEmail(event: ResendWebhookEvent): string | null {
    if (!event.data) {
      return null;
    }

    // For email.received events, leadEmail is the sender (from field)
    if (event.type === 'email.received') {
      const from = event.data.from;
      if (!from) {
        return null;
      }
      return this.extractEmailAddress(from);
    } else {
      // For all other events (delivered, opened, clicked, etc.), leadEmail is the recipient (to field)
      const to = event.data.to;
      if (!to) {
        return null;
      }
      
      // Handle both array and string formats
      const recipient = Array.isArray(to) ? to[0] : to;
      if (!recipient) {
        return null;
      }
      
      return this.extractEmailAddress(recipient);
    }
  }

  async addEmailEvent(event: ResendWebhookEvent, emailDomain: string, eventId: string, overrideLeadEmail?: string): Promise<EmailEvent> {
    const processedAt = new Date().toISOString();

    // Extract leadEmail based on event type, or use override if provided
    const leadEmail = overrideLeadEmail || this.extractLeadEmail(event);

    const emailEvent: EmailEvent = {
      eventId,
      emailId: event.data.email_id,
      emailDomain,
      eventType: event.type,
      createdAt: event.created_at,
      data: event.data,
      processedAt,
      ...(leadEmail && { leadEmail }) // Only include leadEmail if it was successfully extracted
    };

    const params = {
      TableName: TABLE_NAME,
      Item: emailEvent
    };

    await dynamodb.put(params).promise();

    return emailEvent;
  }

  /**
   * Batch add multiple email events
   * Uses DynamoDB batchWrite for better performance (up to 25 items at a time)
   */
  async addEmailEvents(events: Array<{
    event: ResendWebhookEvent;
    emailDomain: string;
    eventId: string;
    overrideLeadEmail?: string;
  }>): Promise<{ successCount: number; failedCount: number }> {
    const processedAt = new Date().toISOString();
    let successCount = 0;
    let failedCount = 0;

    // Process in batches of 25 (DynamoDB limit)
    const batchSize = 25;
    for (let i = 0; i < events.length; i += batchSize) {
      const batch = events.slice(i, i + batchSize);

      const emailEvents = batch.map(({ event, emailDomain, eventId, overrideLeadEmail }) => {
        const leadEmail = overrideLeadEmail || this.extractLeadEmail(event);

        return {
          eventId,
          emailId: event.data.email_id,
          emailDomain,
          eventType: event.type,
          createdAt: event.created_at,
          data: event.data,
          processedAt,
          ...(leadEmail && { leadEmail })
        };
      });

      const params = {
        RequestItems: {
          [TABLE_NAME]: emailEvents.map(event => ({
            PutRequest: {
              Item: event
            }
          }))
        }
      };

      try {
        let result = await dynamodb.batchWrite(params).promise();
        let unprocessedItems = result.UnprocessedItems?.[TABLE_NAME] || [];

        // Retry unprocessed items with exponential backoff
        let retries = 0;
        const maxRetries = 3;

        while (unprocessedItems.length > 0 && retries < maxRetries) {
          retries++;
          const backoffMs = Math.min(1000 * Math.pow(2, retries - 1), 5000); // 1s, 2s, 4s max

          console.log(`Retrying ${unprocessedItems.length} unprocessed items (attempt ${retries}/${maxRetries})...`);
          await new Promise(resolve => setTimeout(resolve, backoffMs));

          const retryParams = {
            RequestItems: {
              [TABLE_NAME]: unprocessedItems
            }
          };

          result = await dynamodb.batchWrite(retryParams).promise();
          unprocessedItems = result.UnprocessedItems?.[TABLE_NAME] || [];
        }

        // Count final results
        const finalUnprocessedCount = unprocessedItems.length;
        successCount += batch.length - finalUnprocessedCount;
        failedCount += finalUnprocessedCount;

        if (finalUnprocessedCount > 0) {
          console.warn(`Batch write had ${finalUnprocessedCount} unprocessed items after ${retries} retries`);
        }
      } catch (error) {
        console.error('Batch write error:', error);
        failedCount += batch.length;
      }
    }

    return { successCount, failedCount };
  }

  async updateEmailEventContent(eventId: string, emailContent: {
    html?: string;
    text?: string;
    headers?: Record<string, string>;
  }): Promise<void> {
    // Truncate content to 10k characters if needed
    const truncatedContent = {
      html: emailContent.html && emailContent.html.length > 10000 
        ? emailContent.html.substring(0, 10000) + '... [truncated]'
        : emailContent.html,
      text: emailContent.text && emailContent.text.length > 10000 
        ? emailContent.text.substring(0, 10000) + '... [truncated]'
        : emailContent.text,
      headers: emailContent.headers
    };

    const params = {
      TableName: TABLE_NAME,
      Key: {
        eventId
      },
      UpdateExpression: 'SET emailContent = :emailContent',
      ExpressionAttributeValues: {
        ':emailContent': truncatedContent
      }
    };

    await dynamodb.update(params).promise();
  }

  async getEventsByEmailId(emailId: string): Promise<EmailEvent[]> {
    const allItems: EmailEvent[] = [];
    let lastEvaluatedKey: any = undefined;

    do {
      const params: any = {
        TableName: TABLE_NAME,
        IndexName: 'EmailIdIndex',
        KeyConditionExpression: 'emailId = :emailId',
        ExpressionAttributeValues: {
          ':emailId': emailId
        }
      };

      if (lastEvaluatedKey) {
        params.ExclusiveStartKey = lastEvaluatedKey;
      }

      const result = await dynamodb.query(params).promise();
      
      if (result.Items) {
        allItems.push(...(result.Items as EmailEvent[]));
      }
      
      lastEvaluatedKey = result.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    return allItems;
  }

  async getEventsByEmailDomain(emailDomain: string): Promise<EmailEvent[]> {
    const allItems: EmailEvent[] = [];
    let lastEvaluatedKey: any = undefined;

    do {
      const params: any = {
        TableName: TABLE_NAME,
        IndexName: 'EmailDomainIndex',
        KeyConditionExpression: 'emailDomain = :emailDomain',
        ExpressionAttributeValues: {
          ':emailDomain': emailDomain
        }
      };

      if (lastEvaluatedKey) {
        params.ExclusiveStartKey = lastEvaluatedKey;
      }

      const result = await dynamodb.query(params).promise();
      
      if (result.Items) {
        allItems.push(...(result.Items as EmailEvent[]));
      }
      
      lastEvaluatedKey = result.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    return allItems;
  }

  /**
   * Get events by email domain and lead email.
   * Uses the EmailDomainLeadEmailIndex composite GSI for efficient querying.
   * 
   * @param emailDomain The email domain to query
   * @param leadEmail The lead email to filter by (case-insensitive, should be normalized)
   * @returns Filtered email events
   */
  async getEventsByEmailDomainAndLeadEmail(emailDomain: string, leadEmail: string): Promise<EmailEvent[]> {
    const allItems: EmailEvent[] = [];
    let lastEvaluatedKey: any = undefined;
    const normalizedLeadEmail = leadEmail.toLowerCase();

    do {
      const params: any = {
        TableName: TABLE_NAME,
        IndexName: 'EmailDomainLeadEmailIndex',
        KeyConditionExpression: 'emailDomain = :emailDomain AND leadEmail = :leadEmail',
        ExpressionAttributeValues: {
          ':emailDomain': emailDomain,
          ':leadEmail': normalizedLeadEmail
        }
      };

      if (lastEvaluatedKey) {
        params.ExclusiveStartKey = lastEvaluatedKey;
      }

      const result = await dynamodb.query(params).promise();
      
      if (result.Items) {
        allItems.push(...(result.Items as EmailEvent[]));
      }
      
      lastEvaluatedKey = result.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    return allItems;
  }

  async getEventById(eventId: string): Promise<EmailEvent | null> {
    const params = {
      TableName: TABLE_NAME,
      Key: {
        eventId
      }
    };

    const result = await dynamodb.get(params).promise();
    return result.Item as EmailEvent || null;
  }

  async eventExists(eventId: string): Promise<boolean> {
    const event = await this.getEventById(eventId);
    return event !== null;
  }

  /**
   * Upsert a LinkedIn message as an engagement event.
   * Uses 'linkedin_msg_{messageId}' as eventId for idempotent upserts.
   * emailDomain should be 'linkedin-{listId}', leadEmail should be the normalized LinkedIn profile URL.
   */
  async addLinkedInMessageEvent(params: {
    eventId: string;
    emailDomain: string;
    leadEmail: string;
    eventType: 'linkedin.message.sent' | 'linkedin.message.received' | 'linkedin.inmail.sent';
    text: string | null;
    timestamp: string;
    senderId: string;
    messageProviderId: string;
  }): Promise<void> {
    const item = {
      eventId: params.eventId,
      emailId: params.messageProviderId,
      emailDomain: params.emailDomain,
      eventType: params.eventType,
      createdAt: params.timestamp,
      processedAt: new Date().toISOString(),
      leadEmail: params.leadEmail,
      data: {
        text: params.text,
        sender_id: params.senderId,
      } as any,
    };

    await dynamodb.put({ TableName: TABLE_NAME, Item: item }).promise();
  }

}

export const emailEventsDb = new EmailEventsDb();
