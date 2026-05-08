import AWS from "aws-sdk";
import { v4 as uuidv4 } from "uuid";

const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";
const TABLE_NAME = `${TABLE_PREFIX}AW-Characters`;

const dynamodb = new AWS.DynamoDB.DocumentClient();

export interface VideoCharacter {
  characterId: string;
  userId: string;
  name: string;
  description: string;
  referenceImageUrl: string;
  referenceImageKey: string;
  prompt: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCharacterInput {
  name: string;
  description: string;
  referenceImageUrl: string;
  referenceImageKey: string;
  prompt: string;
}

export const characterDb = {
  async listCharacters(userId: string): Promise<VideoCharacter[]> {
    const result = await dynamodb
      .query({
        TableName: TABLE_NAME,
        KeyConditionExpression: "userId = :uid",
        ExpressionAttributeValues: { ":uid": userId },
      })
      .promise();
    return (result.Items || []) as VideoCharacter[];
  },

  async getCharacterById(characterId: string): Promise<VideoCharacter | null> {
    const result = await dynamodb
      .query({
        TableName: TABLE_NAME,
        IndexName: "CharacterIdIndex",
        KeyConditionExpression: "characterId = :cid",
        ExpressionAttributeValues: { ":cid": characterId },
      })
      .promise();
    if (!result.Items || result.Items.length === 0) return null;
    return result.Items[0] as VideoCharacter;
  },

  async createCharacter(
    userId: string,
    input: CreateCharacterInput
  ): Promise<VideoCharacter> {
    const now = new Date().toISOString();
    const character: VideoCharacter = {
      characterId: uuidv4(),
      userId,
      name: input.name,
      description: input.description,
      referenceImageUrl: input.referenceImageUrl,
      referenceImageKey: input.referenceImageKey,
      prompt: input.prompt,
      createdAt: now,
      updatedAt: now,
    };
    await dynamodb
      .put({ TableName: TABLE_NAME, Item: character })
      .promise();
    return character;
  },

  async deleteCharacter(userId: string, characterId: string): Promise<void> {
    await dynamodb
      .delete({
        TableName: TABLE_NAME,
        Key: { userId, characterId },
      })
      .promise();
  },
};
