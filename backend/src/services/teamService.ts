import AWS from "aws-sdk";
import dotenv from "dotenv";
import path from "path";
import { v4 as uuidv4 } from "uuid";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";

// Table names
const TEAMS_TABLE = `${TABLE_PREFIX}AW-Teams`;
const TEAM_MEMBERS_TABLE = `${TABLE_PREFIX}AW-TeamMembers`;
const TEAM_INVITES_TABLE = `${TABLE_PREFIX}AW-TeamInvites`;

// Configure AWS SDK
AWS.config.update({
  region: process.env.AWS_REGION || "us-west-2",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
  },
});

const dynamodb = new AWS.DynamoDB.DocumentClient();

// ─── Types ──────────────────────────────────────────────────────────────

export interface Team {
  teamId: string;
  name: string;
  ownerUserId: string;
  createdAt: string;
  updatedAt: string;
  settings?: Record<string, any>;
}

export type TeamMemberRole = "owner" | "admin" | "member" | "viewer";

export interface TeamMember {
  teamId: string;
  userId: string;
  role: TeamMemberRole;
  invitedBy: string;
  joinedAt: string;
  status: "active" | "inactive";
}

export interface TeamInvite {
  inviteId: string;
  teamId: string;
  email: string;
  role: TeamMemberRole;
  invitedBy: string;
  createdAt: string;
  expiresAt: string;
  status: "pending" | "accepted" | "expired" | "revoked";
}

// ─── Error handler ──────────────────────────────────────────────────────

const handleError = (error: any, operation: string): never => {
  console.error(`TeamService ${operation} error:`, error);
  throw new Error(`Error during ${operation}: ${error.message}`);
};

// ─── Service ────────────────────────────────────────────────────────────

class TeamService {
  // ── Teams CRUD ──────────────────────────────────────────────────────

  async createTeam(params: {
    name: string;
    ownerUserId: string;
    settings?: Record<string, any>;
  }): Promise<Team> {
    const now = new Date().toISOString();
    const teamId = uuidv4();

    const team: Team = {
      teamId,
      name: params.name,
      ownerUserId: params.ownerUserId,
      createdAt: now,
      updatedAt: now,
      settings: params.settings,
    };

    try {
      // Create the team
      await dynamodb
        .put({ TableName: TEAMS_TABLE, Item: team })
        .promise();

      // Add the owner as a member with 'owner' role
      const ownerMember: TeamMember = {
        teamId,
        userId: params.ownerUserId,
        role: "owner",
        invitedBy: params.ownerUserId,
        joinedAt: now,
        status: "active",
      };
      await dynamodb
        .put({ TableName: TEAM_MEMBERS_TABLE, Item: ownerMember })
        .promise();

      return team;
    } catch (error) {
      return handleError(error, "createTeam");
    }
  }

  async getTeam(teamId: string): Promise<Team | null> {
    try {
      const result = await dynamodb
        .get({ TableName: TEAMS_TABLE, Key: { teamId } })
        .promise();
      return (result.Item as Team) || null;
    } catch (error) {
      return handleError(error, "getTeam");
    }
  }

  async updateTeam(
    teamId: string,
    updates: { name?: string; settings?: Record<string, any> }
  ): Promise<Team> {
    const fields = Object.entries(updates).filter(
      ([, v]) => v !== undefined
    );
    if (fields.length === 0) {
      throw new Error("No fields to update");
    }

    const now = new Date().toISOString();
    const expressionParts: string[] = ["#updatedAt = :updatedAt"];
    const names: Record<string, string> = { "#updatedAt": "updatedAt" };
    const values: Record<string, any> = { ":updatedAt": now };

    fields.forEach(([key, value]) => {
      const attr = `#${key}`;
      const val = `:${key}`;
      expressionParts.push(`${attr} = ${val}`);
      names[attr] = key;
      values[val] = value;
    });

    try {
      const result = await dynamodb
        .update({
          TableName: TEAMS_TABLE,
          Key: { teamId },
          UpdateExpression: `SET ${expressionParts.join(", ")}`,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ReturnValues: "ALL_NEW",
        })
        .promise();
      return result.Attributes as Team;
    } catch (error) {
      return handleError(error, "updateTeam");
    }
  }

  // ── Members CRUD ────────────────────────────────────────────────────

  async addMember(params: {
    teamId: string;
    userId: string;
    role?: TeamMemberRole;
    invitedBy: string;
  }): Promise<TeamMember> {
    const member: TeamMember = {
      teamId: params.teamId,
      userId: params.userId,
      role: params.role || "member",
      invitedBy: params.invitedBy,
      joinedAt: new Date().toISOString(),
      status: "active",
    };

    try {
      await dynamodb
        .put({ TableName: TEAM_MEMBERS_TABLE, Item: member })
        .promise();
      return member;
    } catch (error) {
      return handleError(error, "addMember");
    }
  }

  async removeMember(teamId: string, userId: string): Promise<void> {
    try {
      await dynamodb
        .delete({
          TableName: TEAM_MEMBERS_TABLE,
          Key: { teamId, userId },
        })
        .promise();
    } catch (error) {
      return handleError(error, "removeMember");
    }
  }

  async getTeamMembers(teamId: string): Promise<TeamMember[]> {
    try {
      const result = await dynamodb
        .query({
          TableName: TEAM_MEMBERS_TABLE,
          KeyConditionExpression: "teamId = :teamId",
          ExpressionAttributeValues: { ":teamId": teamId },
        })
        .promise();
      return (result.Items as TeamMember[]) || [];
    } catch (error) {
      return handleError(error, "getTeamMembers");
    }
  }

  async getTeamsForUser(userId: string): Promise<TeamMember[]> {
    try {
      const result = await dynamodb
        .query({
          TableName: TEAM_MEMBERS_TABLE,
          IndexName: "userId-index",
          KeyConditionExpression: "userId = :userId",
          ExpressionAttributeValues: { ":userId": userId },
        })
        .promise();
      return (result.Items as TeamMember[]) || [];
    } catch (error) {
      return handleError(error, "getTeamsForUser");
    }
  }

  // ── Invites CRUD ────────────────────────────────────────────────────

  async createInvite(params: {
    teamId: string;
    email: string;
    role: TeamMemberRole;
    invitedBy: string;
    expiresInDays?: number;
  }): Promise<TeamInvite> {
    const now = new Date();
    const expiresAt = new Date(now);
    expiresAt.setDate(expiresAt.getDate() + (params.expiresInDays || 7));

    const invite: TeamInvite = {
      inviteId: uuidv4(),
      teamId: params.teamId,
      email: params.email,
      role: params.role,
      invitedBy: params.invitedBy,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      status: "pending",
    };

    try {
      await dynamodb
        .put({ TableName: TEAM_INVITES_TABLE, Item: invite })
        .promise();
      return invite;
    } catch (error) {
      return handleError(error, "createInvite");
    }
  }

  async getInvite(inviteId: string): Promise<TeamInvite | null> {
    try {
      const result = await dynamodb
        .get({
          TableName: TEAM_INVITES_TABLE,
          Key: { inviteId },
        })
        .promise();
      return (result.Item as TeamInvite) || null;
    } catch (error) {
      return handleError(error, "getInvite");
    }
  }
}

// Export singleton
export const teamService = new TeamService();
