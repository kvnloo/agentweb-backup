import { dynamodb } from '../config/aws';
import { ResendWebhookEvent } from './webhookService';
const TABLE_PREFIX = process.env.NODE_ENV === 'production' ? 'prod-' : 'Dev-';
const TABLE_NAME = `${TABLE_PREFIX}AW-EmailEvents`;

export interface EmailEvent {
  eventId: string;
  emailId: string;
  emailDomain: string;
  eventType: string;
  createdAt: string;
  data: ResendWebhookEvent['data'];
  processedAt: string;
}

class EmailEventsDb {
  async addEmailEvent(event: ResendWebhookEvent, emailDomain: string, eventId: string): Promise<EmailEvent> {
    const processedAt = new Date().toISOString();

    const emailEvent: EmailEvent = {
      eventId,
      emailId: event.data.email_id,
      emailDomain,
      eventType: event.type,
      createdAt: event.created_at,
      data: event.data,
      processedAt
    };

    const params = {
      TableName: TABLE_NAME,
      Item: emailEvent
    };

    await dynamodb.put(params).promise();
    
    return emailEvent;
  }

  async getEventsByEmailId(emailId: string): Promise<EmailEvent[]> {
    const params = {
      TableName: TABLE_NAME,
      IndexName: 'EmailIdIndex',
      KeyConditionExpression: 'emailId = :emailId',
      ExpressionAttributeValues: {
        ':emailId': emailId
      }
    };

    const result = await dynamodb.query(params).promise();
    return result.Items as EmailEvent[] || [];
  }

  async getEventsByEmailDomain(emailDomain: string): Promise<EmailEvent[]> {
    const params = {
      TableName: TABLE_NAME,
      IndexName: 'EmailDomainIndex',
      KeyConditionExpression: 'emailDomain = :emailDomain',
      ExpressionAttributeValues: {
        ':emailDomain': emailDomain
      }
    };

    const result = await dynamodb.query(params).promise();
    return result.Items as EmailEvent[] || [];
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
