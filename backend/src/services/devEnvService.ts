import AWS from "aws-sdk";
import axios from "axios";
import path from "path";
import fs from "fs";
import { getSecret } from "../utils/secretsManager";

const REGION = process.env.AWS_REGION || "us-west-2";
const PROFILE_NAME = "agentweb-test-env-profile";
const INSTANCE_TYPE = "t3.xlarge";
const VOLUME_SIZE = 50;

const ec2 = new AWS.EC2({ region: REGION });
const ssm = new AWS.SSM({ region: REGION });
const iam = new AWS.IAM({ region: REGION });

// Notion API base URL
const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

// Cached Notion token (fetched from Secrets Manager on first use)
let cachedNotionToken: string | null = null;

/**
 * Get Notion API token, caching after first fetch from Secrets Manager.
 */
async function getNotionToken(): Promise<string> {
  if (cachedNotionToken) return cachedNotionToken;
  cachedNotionToken = await getSecret("agentweb/test-env/notion-token");
  return cachedNotionToken;
}

/**
 * Make a Notion API request with authorization headers.
 */
async function notionRequest(
  method: "get" | "post" | "patch",
  path: string,
  data?: any
) {
  const token = await getNotionToken();
  try {
    return await axios({
      method,
      url: `${NOTION_API}${path}`,
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      data,
    });
  } catch (err: any) {
    if (err.response) {
      console.error(`[devEnv] Notion API error (${method.toUpperCase()} ${path}):`, JSON.stringify(err.response.data));
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Notion API helpers
// ---------------------------------------------------------------------------

/**
 * Fetch a Notion page's title, status, and instance info.
 */
export async function getNotionPage(
  pageId: string
): Promise<{ title: string; status: string; instanceId: string; sgId: string; databaseId: string }> {
  const res = await notionRequest("get", `/pages/${pageId}`);
  const props = res.data.properties;

  // Extract title from whichever property has type "title"
  let title = "";
  for (const key of Object.keys(props)) {
    if (props[key].type === "title") {
      title = props[key].title.map((t: any) => t.plain_text).join("");
      break;
    }
  }

  // Extract status
  let status = "";
  if (props.Status?.status?.name) {
    status = props.Status.status.name;
  } else if (props.Status?.select?.name) {
    status = props.Status.select.name;
  }

  // Extract Instance ID (rich_text property — may not exist yet)
  let instanceId = "";
  if (props["Instance ID"]?.rich_text?.length > 0) {
    instanceId = props["Instance ID"].rich_text
      .map((t: any) => t.plain_text)
      .join("");
  }

  // Extract SG ID (rich_text property — may not exist yet)
  let sgId = "";
  if (props["SG ID"]?.rich_text?.length > 0) {
    sgId = props["SG ID"].rich_text
      .map((t: any) => t.plain_text)
      .join("");
  }

  // Extract database ID from parent
  const databaseId = res.data.parent?.database_id || "";

  return { title, status, instanceId, sgId, databaseId };
}

/**
 * Ensure the Notion database has the required properties for dev env tracking.
 * This is idempotent — existing properties are not modified.
 */
async function ensureDatabaseProperties(databaseId: string): Promise<void> {
  if (!databaseId) return;

  try {
    await notionRequest("patch", `/databases/${databaseId}`, {
      properties: {
        "Instance ID": { rich_text: {} },
        "Public IP": { rich_text: {} },
        "SG ID": { rich_text: {} },
      },
    });
    console.log(`[devEnv] Database properties ensured on ${databaseId}`);
  } catch (err: any) {
    // If properties already exist with the right type, Notion may still return 200.
    // Log but don't fail — the page update will give a clearer error if needed.
    console.warn(`[devEnv] Could not ensure database properties:`, err.response?.data || err.message);
  }
}

/**
 * Fetch a Notion page's block content as plain text.
 */
export async function getNotionPageContent(pageId: string): Promise<string> {
  const res = await notionRequest(
    "get",
    `/blocks/${pageId}/children?page_size=100`
  );
  const blocks = res.data.results || [];

  const lines: string[] = [];
  for (const block of blocks) {
    const richText =
      block.paragraph?.rich_text ||
      block.heading_1?.rich_text ||
      block.heading_2?.rich_text ||
      block.heading_3?.rich_text ||
      block.bulleted_list_item?.rich_text ||
      block.numbered_list_item?.rich_text ||
      block.to_do?.rich_text ||
      block.toggle?.rich_text ||
      block.callout?.rich_text ||
      block.quote?.rich_text ||
      [];
    const text = richText.map((t: any) => t.plain_text).join("");
    if (text) lines.push(text);
  }

  return lines.join("\n");
}

/**
 * Update Notion page properties (Instance ID, Public IP, SG ID, status).
 */
export async function updateNotionPageProperties(
  pageId: string,
  updates: {
    instanceId?: string;
    publicIp?: string;
    sgId?: string;
    status?: string;
  }
): Promise<void> {
  const properties: any = {};

  if (updates.instanceId !== undefined) {
    properties["Instance ID"] = {
      rich_text: updates.instanceId
        ? [{ text: { content: updates.instanceId } }]
        : [],
    };
  }

  if (updates.publicIp !== undefined) {
    properties["Public IP"] = {
      rich_text: updates.publicIp
        ? [{ text: { content: updates.publicIp } }]
        : [],
    };
  }

  if (updates.sgId !== undefined) {
    properties["SG ID"] = {
      rich_text: updates.sgId
        ? [{ text: { content: updates.sgId } }]
        : [],
    };
  }

  if (updates.status !== undefined) {
    properties.Status = {
      status: { name: updates.status },
    };
  }

  await notionRequest("patch", `/pages/${pageId}`, { properties });
}

/**
 * Add a comment to a Notion page.
 */
export async function addNotionComment(
  pageId: string,
  text: string
): Promise<void> {
  await notionRequest("post", "/comments", {
    parent: { page_id: pageId },
    rich_text: [{ text: { content: text } }],
  });
}

// ---------------------------------------------------------------------------
// EC2 launch / teardown
// ---------------------------------------------------------------------------

/**
 * Launch a dev environment EC2 instance triggered by a Notion page.
 * Updates the Notion page with instance details when ready.
 */
export async function launchEnvironment(
  notionPageId: string,
  title: string,
  content: string,
  databaseId: string
): Promise<void> {
  console.log(
    `[devEnv] Launching environment for Notion page ${notionPageId}: "${title}"`
  );

  try {
    // 0. Ensure database has the required properties
    await ensureDatabaseProperties(databaseId);

    // 1. Resolve AMI
    const amiRes = await ssm
      .getParameters({
        Names: [
          "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64",
        ],
      })
      .promise();
    const amiId = amiRes.Parameters?.[0]?.Value;
    if (!amiId) throw new Error("Could not resolve AMI ID");
    console.log(`[devEnv] AMI: ${amiId}`);

    // 2. Get default VPC
    const vpcRes = await ec2
      .describeVpcs({
        Filters: [{ Name: "isDefault", Values: ["true"] }],
      })
      .promise();
    const vpcId = vpcRes.Vpcs?.[0]?.VpcId;
    if (!vpcId) throw new Error("No default VPC found");
    console.log(`[devEnv] VPC: ${vpcId}`);

    // 3. Create security group (port 5175 open to 0.0.0.0/0 only)
    const sgName = `agentweb-test-env-notion-${notionPageId.slice(0, 8)}`;
    const sgRes = await ec2
      .createSecurityGroup({
        GroupName: sgName,
        Description: `AgentWeb dev env for Notion page ${notionPageId}`,
        VpcId: vpcId,
      })
      .promise();
    const sgId = sgRes.GroupId!;
    console.log(`[devEnv] Security group: ${sgId}`);

    // Tag the security group
    await ec2
      .createTags({
        Resources: [sgId],
        Tags: [
          { Key: "purpose", Value: "test-env" },
          { Key: "notion-page-id", Value: notionPageId },
        ],
      })
      .promise();

    // Open ports 22 (SSH) and 5175 (test-env-access / IP registration) to the world
    await ec2
      .authorizeSecurityGroupIngress({
        GroupId: sgId,
        IpPermissions: [
          {
            IpProtocol: "tcp",
            FromPort: 22,
            ToPort: 22,
            IpRanges: [{ CidrIp: "0.0.0.0/0" }],
          },
          {
            IpProtocol: "tcp",
            FromPort: 5175,
            ToPort: 5175,
            IpRanges: [{ CidrIp: "0.0.0.0/0" }],
          },
        ],
      })
      .promise();

    // 4. Read user-data script
    const userDataPath = path.resolve(
      __dirname,
      "../../../test-env/user-data-dev-auto.sh"
    );
    const userDataScript = fs.readFileSync(userDataPath, "utf-8");
    const userDataBase64 = Buffer.from(userDataScript).toString("base64");

    // 5. Look up instance profile ARN
    const profileRes = await iam
      .getInstanceProfile({ InstanceProfileName: PROFILE_NAME })
      .promise();
    const profileArn = profileRes.InstanceProfile.Arn;

    // 6. Launch EC2 instance
    const runRes = await ec2
      .runInstances({
        ImageId: amiId,
        InstanceType: INSTANCE_TYPE,
        MinCount: 1,
        MaxCount: 1,
        SecurityGroupIds: [sgId],
        IamInstanceProfile: { Name: PROFILE_NAME },
        InstanceInitiatedShutdownBehavior: "terminate",
        UserData: userDataBase64,
        TagSpecifications: [
          {
            ResourceType: "instance",
            Tags: [
              {
                Key: "Name",
                Value: `dev_${title.slice(0, 60)}`,
              },
              { Key: "purpose", Value: "test-env" },
              { Key: "mode", Value: "dev" },
              { Key: "notion-page-id", Value: notionPageId },
              { Key: "sg-id", Value: sgId },
            ],
          },
        ],
        BlockDeviceMappings: [
          {
            DeviceName: "/dev/xvda",
            Ebs: { VolumeSize: VOLUME_SIZE, VolumeType: "gp3" },
          },
        ],
      })
      .promise();

    const instanceId = runRes.Instances?.[0]?.InstanceId;
    if (!instanceId) throw new Error("EC2 launch returned no instance ID");
    console.log(`[devEnv] Instance launched: ${instanceId}`);

    // 7. Poll until running and get public IP
    console.log(`[devEnv] Waiting for instance to enter running state...`);
    await ec2.waitFor("instanceRunning", { InstanceIds: [instanceId] }).promise();

    const descRes = await ec2
      .describeInstances({ InstanceIds: [instanceId] })
      .promise();
    const publicIp =
      descRes.Reservations?.[0]?.Instances?.[0]?.PublicIpAddress;
    if (!publicIp)
      throw new Error("Instance has no public IP after entering running state");
    console.log(`[devEnv] Public IP: ${publicIp}`);

    // 8. Update Notion page properties
    await updateNotionPageProperties(notionPageId, {
      instanceId,
      publicIp,
      sgId,
      status: "In Progress",
    });

    // 9. Add Notion comment with dev instructions
    const comment = [
      `Dev environment launched!`,
      ``,
      `Register your IP: http://${publicIp}:5175`,
      `SSH: ssh ec2-user@${publicIp} (password in Secrets Manager: agentweb/test-env/ssh-password)`,
      ``,
      `Services (after IP registration):`,
      `  Backend:          http://${publicIp}:3001`,
      `  Partner Portal:   http://${publicIp}:5173`,
      `  Customer Portal:  http://${publicIp}:5174`,
      ``,
      `Claude Code is running "prep branch for ${title}" in tmux.`,
      `SSH in and run: tmux attach -t claude`,
      `Set status to "Done" when finished to tear down.`,
    ].join("\n");

    await addNotionComment(notionPageId, comment);
    console.log(`[devEnv] Launch complete for ${instanceId} (${publicIp})`);
  } catch (error: any) {
    console.error(`[devEnv] Launch failed for page ${notionPageId}:`, error);
    // Try to update Notion with error status
    try {
      await addNotionComment(
        notionPageId,
        `Dev environment launch failed: ${error.message || error}`
      );
    } catch (commentErr) {
      console.error(`[devEnv] Failed to add error comment to Notion:`, commentErr);
    }
  }
}

/**
 * Tear down a dev environment EC2 instance triggered by a Notion page.
 * Reads instance details from Notion page properties, terminates, cleans up.
 */
export async function teardownEnvironment(
  notionPageId: string
): Promise<void> {
  console.log(
    `[devEnv] Tearing down environment for Notion page ${notionPageId}`
  );

  try {
    // 1. Read Notion page properties for Instance ID and SG ID
    const page = await getNotionPage(notionPageId);
    const { instanceId, sgId } = page;

    if (!instanceId) {
      console.log(
        `[devEnv] No Instance ID on Notion page ${notionPageId}, nothing to tear down`
      );
      return;
    }

    // 2. Terminate EC2 instance
    console.log(`[devEnv] Terminating instance ${instanceId}...`);
    await ec2
      .terminateInstances({ InstanceIds: [instanceId] })
      .promise();

    // 3. Wait for termination before deleting SG
    console.log(`[devEnv] Waiting for instance to terminate...`);
    await ec2
      .waitFor("instanceTerminated", { InstanceIds: [instanceId] })
      .promise();

    // 4. Delete security group
    if (sgId) {
      console.log(`[devEnv] Deleting security group ${sgId}...`);
      try {
        await ec2.deleteSecurityGroup({ GroupId: sgId }).promise();
      } catch (sgErr: any) {
        console.warn(
          `[devEnv] Could not delete security group ${sgId}: ${sgErr.message}`
        );
      }
    }

    // 5. Clear Notion page properties
    await updateNotionPageProperties(notionPageId, {
      instanceId: "",
      publicIp: "",
      sgId: "",
    });

    // 6. Add teardown comment
    await addNotionComment(
      notionPageId,
      `Dev environment torn down. Instance ${instanceId} terminated.`
    );

    console.log(`[devEnv] Teardown complete for ${instanceId}`);
  } catch (error: any) {
    console.error(
      `[devEnv] Teardown failed for page ${notionPageId}:`,
      error
    );
    try {
      await addNotionComment(
        notionPageId,
        `Dev environment teardown failed: ${error.message || error}`
      );
    } catch (commentErr) {
      console.error(`[devEnv] Failed to add error comment to Notion:`, commentErr);
    }
  }
}
