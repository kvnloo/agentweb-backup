import AWS from "aws-sdk";
import dotenv from "dotenv";
import path from "path";

// Load environment variables from .env file
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

// Get table prefix based on NODE_ENV (defaults to empty string for production)
const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";

// Make sure we have a DynamoDB instance
const dynamodb = new AWS.DynamoDB.DocumentClient({
  region: process.env.AWS_REGION || "us-west-2",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
  },
});

export interface Setting {
  settingName: string;
  settingValue: string;
  description?: string;
  updatedAt: string;
  updatedBy: string;
}

export class SettingsService {
  private tableName: string;

  constructor() {
    this.tableName = `${TABLE_PREFIX}AW-Settings`;
  }

  async getSetting(settingName: string): Promise<Setting | null> {
    try {
      const params = {
        TableName: this.tableName,
        Key: {
          settingName: settingName
        }
      };

      const result = await dynamodb.get(params).promise();
      return result.Item as Setting || null;
    } catch (error) {
      console.error('Error getting setting:', error);
      throw error;
    }
  }

  async setSetting(settingName: string, settingValue: string, description?: string, updatedBy: string = 'system'): Promise<Setting> {
    try {
      const timestamp = new Date().toISOString();
      
      const setting: Setting = {
        settingName,
        settingValue,
        description,
        updatedAt: timestamp,
        updatedBy
      };

      const params = {
        TableName: this.tableName,
        Item: setting
      };

      await dynamodb.put(params).promise();
      return setting;
    } catch (error) {
      console.error('Error setting setting:', error);
      throw error;
    }
  }

  async getAllSettings(): Promise<Setting[]> {
    try {
      const params = {
        TableName: this.tableName
      };

      const result = await dynamodb.scan(params).promise();
      return result.Items as Setting[] || [];
    } catch (error) {
      console.error('Error getting all settings:', error);
      throw error;
    }
  }

  async deleteSetting(settingName: string): Promise<void> {
    try {
      const params = {
        TableName: this.tableName,
        Key: {
          settingName: settingName
        }
      };

      await dynamodb.delete(params).promise();
    } catch (error) {
      console.error('Error deleting setting:', error);
      throw error;
    }
  }
}

export const settingsService = new SettingsService();
