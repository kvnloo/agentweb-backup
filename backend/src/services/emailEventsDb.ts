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

  async addEmailEvent(event: ResendWebhookEvent, emailDomain: string, eventId: string): Promise<EmailEvent> {
    const processedAt = new Date().toISOString();

    // Extract leadEmail based on event type
    const leadEmail = this.extractLeadEmail(event);

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

}

export const emailEventsDb = new EmailEventsDb();
