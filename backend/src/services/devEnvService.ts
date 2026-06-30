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

// A real EC2 instance ID looks like `i-0abc123...`. A dev-env Notion page that
// never finished provisioning can carry a placeholder like "pending" instead.
// Calling EC2 terminateInstances with such a value throws
// InvalidInstanceID.Malformed on every webhook tick — the loop that filled the
// prod disk on 2026-06-26. Require the `i-` prefix before any EC2 call (the real
// bad value had no prefix); placeholders like "pending"/"launching" are rejected.
const EC2_INSTANCE_ID_RE = /^i-[a-z0-9]+$/i;

/**
 * One-line summary of an error for logging. NEVER log the raw AWS-SDK/Axios
 * error object — it serializes the full request `config` + `data`, which is how
 * a tight retry loop turned into ~79 MB/day of stdout and filled the root disk.
 */
function errSummary(err: any): string {
  if (!err) return "unknown error";
  const code = err.code || err.name || err.response?.status;
  const msg =
    err.response?.data?.message || err.message || String(err);
  return code ? `${code}: ${msg}` : msg;
}

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
      // Log only the Notion error message/code — not the full Axios error
      // (which serializes the entire request config + body).
      console.error(
        `[devEnv] Notion API error (${method.toUpperCase()} ${path}): ${errSummary(err)}`
      );
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
): Promise<{ title: string; status: string; instanceId: string; sgId: string; publicIp: string; databaseId: string; launchedBy: string }> {
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

  // Extract Public IP (rich_text property — may not exist yet)
  let publicIp = "";
  if (props["Public IP"]?.rich_text?.length > 0) {
    publicIp = props["Public IP"].rich_text
      .map((t: any) => t.plain_text)
      .join("");
  }

  // Extract Launched By (rich_text property — may not exist yet)
  let launchedBy = "";
  if (props["Launched By"]?.rich_text?.length > 0) {
    launchedBy = props["Launched By"].rich_text
      .map((t: any) => t.plain_text)
      .join("");
  }

  // Extract database ID from parent
  const databaseId = res.data.parent?.database_id || "";

  return { title, status, instanceId, sgId, publicIp, databaseId, launchedBy };
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
        "Launched By": { rich_text: {} },
      },
    });
    console.log(`[devEnv] Database properties ensured on ${databaseId}`);
  } catch (err: any) {
    // If properties already exist with the right type, Notion may still return 200.
    // Log but don't fail — the page update will give a clearer error if needed.
    console.warn(`[devEnv] Could not ensure database properties:`, err.response?.data || err.message);
  }
}

export interface NotionAttachment {
  url: string;
  name: string;
  type: "image" | "file" | "pdf" | "video";
}

export interface NotionPageContent {
  text: string;
  attachments: NotionAttachment[];
}

const ATTACHMENT_BLOCK_TYPES = ["image", "file", "pdf", "video"] as const;

/**
 * Extract the URL from a Notion file/image/pdf/video block.
 * Notion blocks store files either as `{ type: "file", file: { url } }` (hosted)
 * or `{ type: "external", external: { url } }`.
 */
function extractAttachmentUrl(blockData: any): string | null {
  if (blockData?.type === "file" && blockData.file?.url) {
    return blockData.file.url;
  }
  if (blockData?.type === "external" && blockData.external?.url) {
    return blockData.external.url;
  }
  return null;
}

/**
 * Derive a filename for an attachment block.
 * Tries caption (image), name (file), then falls back to extracting from URL or a default.
 */
function extractAttachmentName(
  blockData: any,
  url: string,
  blockType: string
): string {
  // Image blocks use caption
  const caption = blockData?.caption;
  if (Array.isArray(caption) && caption.length > 0) {
    const text = caption.map((c: any) => c.plain_text).join("");
    if (text) return text;
  }
  // File blocks use name
  if (blockData?.name) return blockData.name;
  // Try to extract filename from URL path
  try {
    const pathname = new URL(url).pathname;
    const segments = pathname.split("/");
    const lastSegment = segments[segments.length - 1];
    if (lastSegment && lastSegment.includes(".")) {
      return decodeURIComponent(lastSegment);
    }
  } catch {
    // ignore URL parse errors
  }
  return `${blockType}_attachment`;
}

/**
 * Fetch a Notion page's block content as plain text and attachment metadata.
 */
export async function getNotionPageContent(
  pageId: string
): Promise<NotionPageContent> {
  const res = await notionRequest(
    "get",
    `/blocks/${pageId}/children?page_size=100`
  );
  const blocks = res.data.results || [];

  const lines: string[] = [];
  const attachments: NotionAttachment[] = [];

  for (const block of blocks) {
    // Extract text from text-bearing blocks
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

    // Extract attachments from file-bearing blocks
    const blockType = block.type as string;
    if (
      ATTACHMENT_BLOCK_TYPES.includes(
        blockType as (typeof ATTACHMENT_BLOCK_TYPES)[number]
      )
    ) {
      const blockData = block[blockType];
      const url = extractAttachmentUrl(blockData);
      if (url) {
        attachments.push({
          url,
          name: extractAttachmentName(blockData, url, blockType),
          type: blockType as NotionAttachment["type"],
        });
      }
    }
  }

  return { text: lines.join("\n"), attachments };
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
    launchedBy?: string;
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

  if (updates.launchedBy !== undefined) {
    properties["Launched By"] = {
      rich_text: updates.launchedBy
        ? [{ text: { content: updates.launchedBy } }]
        : [],
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
// Comment relay helpers
// ---------------------------------------------------------------------------

/**
 * Get the text of a specific Notion comment by listing comments on a page.
 * Notion doesn't have GET /comments/{id}, so we list and find.
 */
export async function getNotionCommentText(
  pageId: string,
  commentId: string
): Promise<string> {
  const res = await notionRequest("get", `/comments?block_id=${pageId}`);
  const comment = res.data.results?.find((c: any) => c.id === commentId);
  if (!comment) return "";
  return comment.rich_text?.map((t: any) => t.plain_text).join("") || "";
}

/**
 * Get the Notion integration's own bot user ID (for filtering out self-comments).
 */
let cachedBotUserId: string | null = null;

export async function getNotionBotUserId(): Promise<string> {
  if (cachedBotUserId) return cachedBotUserId;
  const res = await notionRequest("get", "/users/me");
  cachedBotUserId = res.data.id;
  return cachedBotUserId!;
}

/**
 * Relay a prompt to an EC2 test-env-access instance for Claude Code execution.
 * Uses a shared secret from Secrets Manager for authentication.
 */
export async function relayPromptToEC2(
  publicIp: string,
  prompt: string,
  notionPageId: string
): Promise<void> {
  try {
    const notionToken = await getNotionToken();
    await axios.post(
      `http://${publicIp}:5175/api/claude-prompt`,
      { prompt, notionPageId },
      {
        headers: { "X-Relay-Secret": notionToken },
        timeout: 10000,
      }
    );
    console.log(`[devEnv] Relayed prompt to ${publicIp} for page ${notionPageId}`);
  } catch (err: any) {
    console.error(
      `[devEnv] Failed to relay prompt to ${publicIp}:`,
      err.message || err
    );
  }
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
    const sgName = `agentweb-test-env-notion-${notionPageId.replace(/-/g, "").slice(0, 20)}`;
    let sgId: string;
    try {
      const sgRes = await ec2
        .createSecurityGroup({
          GroupName: sgName,
          Description: `AgentWeb dev env for Notion page ${notionPageId}`,
          VpcId: vpcId,
        })
        .promise();
      sgId = sgRes.GroupId!;
    } catch (sgErr: any) {
      if (sgErr.code === "InvalidGroup.Duplicate") {
        // Reuse existing SG from a previous failed launch attempt
        const existing = await ec2
          .describeSecurityGroups({
            Filters: [
              { Name: "group-name", Values: [sgName] },
              { Name: "vpc-id", Values: [vpcId] },
            ],
          })
          .promise();
        sgId = existing.SecurityGroups?.[0]?.GroupId!;
        console.log(`[devEnv] Reusing existing security group: ${sgId}`);
      } else {
        throw sgErr;
      }
    }
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
    try {
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
    } catch (ruleErr: any) {
      if (ruleErr.code === "InvalidPermission.Duplicate") {
        console.log(`[devEnv] SG ingress rules already exist, skipping`);
      } else {
        throw ruleErr;
      }
    }

    // 4. Read user-data script (EC2 limit: 16384 bytes raw; keep test-env/user-data-dev-auto.sh under that)
    const userDataPath = path.resolve(
      __dirname,
      "../user-data-dev-auto.sh"
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
      launchedBy: process.env.NODE_ENV || "development",
    });

    // 9. Add Notion comment with dev instructions (links are clickable)
    const ipUrl = (port: number) => `http://${publicIp}:${port}`;
    const link = (text: string, url: string) => ({
      text: { content: text, link: { url } },
    });
    const plain = (text: string) => ({ text: { content: text } });

    await notionRequest("post", "/comments", {
      parent: { page_id: notionPageId },
      rich_text: [
        plain("Dev environment launched!\n\nRegister your IP: "),
        link(ipUrl(5175), ipUrl(5175)),
        plain("\n\nSSH (install sshpass first: brew install sshpass):\n  export SSHPASS=<password from 1Password under \"SSH for Cloud Dev\">\n  sshpass -e ssh ec2-user@" + publicIp),
        plain("\n\nServices (after IP registration):\n  Backend:          "),
        link(ipUrl(3001), ipUrl(3001)),
        plain("\n  Partner Portal:   "),
        link(ipUrl(5173), ipUrl(5173)),
        plain("\n  Customer Portal:  "),
        link(ipUrl(5174), ipUrl(5174)),
        plain(`\n\nClaude Code auto-ran "prep branch for ${title}".\nClaude will post its output as a comment when done.\nYou can then continue development by posting comments.\n\nSet status to "Done" when finished to tear down.`),
      ],
    });
    console.log(`[devEnv] Launch complete for ${instanceId} (${publicIp})`);
  } catch (error: any) {
    console.error(`[devEnv] Launch failed for page ${notionPageId}: ${errSummary(error)}`);
    // Try to update Notion with error status
    try {
      await addNotionComment(
        notionPageId,
        `Dev environment launch failed: ${error.message || error}`
      );
    } catch (commentErr) {
      console.error(`[devEnv] Failed to add error comment to Notion: ${errSummary(commentErr)}`);
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

    // A page that never finished provisioning can carry a placeholder (e.g.
    // "pending") instead of a real `i-...` ID. Never hand that to EC2 — it throws
    // InvalidInstanceID.Malformed and, because teardown re-fires on every webhook
    // tick, loops forever. Clear the page so it stops re-triggering, then stop.
    if (!EC2_INSTANCE_ID_RE.test(instanceId)) {
      console.warn(
        `[devEnv] Page ${notionPageId} has no real EC2 instance (instanceId="${instanceId}"); clearing without EC2 teardown`
      );
      await updateNotionPageProperties(notionPageId, {
        instanceId: "",
        publicIp: "",
        sgId: "",
        launchedBy: "",
      });
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
      launchedBy: "",
    });

    // 6. Add teardown comment
    await addNotionComment(
      notionPageId,
      `Dev environment torn down. Instance ${instanceId} terminated.`
    );

    console.log(`[devEnv] Teardown complete for ${instanceId}`);
  } catch (error: any) {
    console.error(
      `[devEnv] Teardown failed for page ${notionPageId}: ${errSummary(error)}`
    );
    try {
      await addNotionComment(
        notionPageId,
        `Dev environment teardown failed: ${error.message || error}`
      );
    } catch (commentErr) {
      console.error(`[devEnv] Failed to add error comment to Notion: ${errSummary(commentErr)}`);
    }
  }
}
