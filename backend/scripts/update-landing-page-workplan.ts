/**
 * Migration script: Update the "Landing Page Builder" work plan in DynamoDB.
 *
 * New simplified flow (no HTML preview step):
 *   1. Brand Guidelines check → read_brand_guidelines
 *   2. Build & Deploy via v0 → create_lead_list, enable_lead_list_public_access, generate_landing_page
 *   3. Review & Edit → edit_landing_page_file, list_landing_page_files, read_landing_page_file
 *
 * Run: npx ts-node scripts/update-landing-page-workplan.ts
 */

import AWS from "aws-sdk";

// Use Dev tables
const TABLE_NAME = process.env.SETTINGS_TABLE || "Dev-AW-Settings";

const dynamodb = new AWS.DynamoDB.DocumentClient({
  region: process.env.AWS_REGION || "us-west-2",
});

const UPDATED_WORK_PLAN = {
  id: "landing-page-builder",
  title: "Landing Page Builder",
  description: "Build a production landing page with lead capture, deployed to Vercel. Emma reads your brand guidelines, sends everything to v0 AI to build a polished React site, creates a CRM lead list for form capture, and deploys automatically. After deployment, you can edit any file via Emma.",
  showInAgentMode: true,
  steps: [
    {
      stepCount: 1,
      title: "Check Brand Guidelines",
      description: "Read the user's brand guidelines to get colors, fonts, tagline, tone, logo, and market strategy. If no brand guidelines exist, ask the user for key brand details before proceeding.",
      requiredFunctionCalls: ["read_brand_guidelines"],
      skillIds: [],
    },
    {
      stepCount: 2,
      title: "Build & Deploy Landing Page",
      description: "Create a CRM lead list for the landing page's contact form, enable public access on it, then call generate_landing_page with a detailed prompt including all brand details. v0 builds a React/Next.js site, pushes to GitHub, and deploys to Vercel automatically. The system automatically includes a design template as inspiration and all brand + market data in the prompt.",
      requiredFunctionCalls: [
        "create_lead_list",
        "enable_lead_list_public_access",
        "generate_landing_page",
      ],
      skillIds: [],
    },
    {
      stepCount: 3,
      title: "Review & Edit",
      description: "Share the deployed URL with the user. If they want changes, use edit_landing_page_file to update specific files in the GitHub repo — changes auto-deploy via Vercel within ~30 seconds. Use list_landing_page_files and read_landing_page_file to explore the repo structure first.",
      requiredFunctionCalls: [],
      skillIds: [],
    },
  ],
};

async function main() {
  // Read current work plans
  const result = await dynamodb
    .get({ TableName: TABLE_NAME, Key: { settingKey: "agent-mode-predefined-workplans" } })
    .promise();

  let workPlans: any[] = [];
  if (result.Item?.settingValue) {
    workPlans = JSON.parse(result.Item.settingValue);
  }

  // Find and replace or add
  const idx = workPlans.findIndex(
    (wp: any) =>
      wp.id === "landing-page-builder" ||
      (wp.title && wp.title.toLowerCase().includes("landing page"))
  );

  if (idx >= 0) {
    console.log(`Updating existing work plan at index ${idx}: "${workPlans[idx].title}"`);
    workPlans[idx] = UPDATED_WORK_PLAN;
  } else {
    console.log("Adding new Landing Page Builder work plan");
    workPlans.push(UPDATED_WORK_PLAN);
  }

  await dynamodb
    .put({
      TableName: TABLE_NAME,
      Item: {
        settingKey: "agent-mode-predefined-workplans",
        settingValue: JSON.stringify(workPlans),
        description: "Agent Mode predefined work plans for Emma AI assistant",
        updatedAt: new Date().toISOString(),
        updatedBy: "migration-script",
      },
    })
    .promise();

  console.log("Done. Updated work plan:");
  console.log(JSON.stringify(UPDATED_WORK_PLAN, null, 2));
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
