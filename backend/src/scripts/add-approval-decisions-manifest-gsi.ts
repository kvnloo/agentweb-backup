import { DynamoDB, STS } from "aws-sdk";

// ENG-1853 review fix: deliberately NO dotenv/`.env` loading, and NO
// hardcoded-region-via-env-var fallback. Both were tried and both failed
// live: this repo's backend/.env carries a stale AWS key AND a stale
// AWS_REGION (a different account and a different region entirely) —
// dotenv fills process.env.AWS_REGION/AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY
// from that file whenever the real shell hasn't already set them (the
// common case — most operators authenticate via aws-cli profile/SSO, which
// sets no such env vars), so a `region: process.env.AWS_REGION || "..."`
// fallback silently resolved to the WRONG region even after removing the
// explicit credential pinning. AW-ApprovalDecisions has only ever lived in
// us-west-2 (verified directly against both the env1 Dev- table and
// production) — hardcoded here rather than sourced from any environment
// value that could be stale. Credentials are left to the AWS SDK's own
// default provider chain entirely (same as `aws-cli`: profile/SSO, then an
// instance role) — never pinned to anything from this process's env.
const REGION = "us-west-2";

const TABLE_PREFIX = process.env.NODE_ENV === "production" ? "" : "Dev-";
const TABLE_NAME = `${TABLE_PREFIX}AW-ApprovalDecisions`;

async function main() {
  const ddb = new DynamoDB({ region: REGION });

  // Pre-flight: print exactly which account/region/table this is about to
  // touch, so a human (or an agent) running this can catch a wrong-identity
  // problem BEFORE any mutation — describeTable below is read-only, but the
  // whole point is to fail loud and visible, not silently touch the wrong
  // place.
  const identity = await new STS({ region: REGION }).getCallerIdentity().promise();
  console.log(
    `Resolved identity: ${identity.Arn} (account ${identity.Account}) — NODE_ENV='${process.env.NODE_ENV}', targeting table '${TABLE_NAME}' in ${REGION}. ` +
    `(An unprefixed table name means production — this only happens when NODE_ENV is exactly 'production'.)`,
  );

  const desc = await ddb.describeTable({ TableName: TABLE_NAME }).promise();
  const indexes = desc.Table?.GlobalSecondaryIndexes ?? [];

  if (indexes.some((i) => i.IndexName === "ManifestIndex")) {
    console.log("ManifestIndex already exists on", TABLE_NAME, "— nothing to do.");
    return;
  }

  const billingMode = desc.Table?.BillingModeSummary?.BillingMode;
  const isOnDemand = billingMode === "PAY_PER_REQUEST";

  console.log(
    "Creating ManifestIndex on",
    TABLE_NAME,
    `(BillingMode: ${billingMode ?? "PROVISIONED"})`
  );

  const createSpec: DynamoDB.CreateGlobalSecondaryIndexAction = {
    IndexName: "ManifestIndex",
    KeySchema: [
      { AttributeName: "manifestId", KeyType: "HASH" },
      { AttributeName: "createdAt", KeyType: "RANGE" },
    ],
    Projection: { ProjectionType: "ALL" },
    ...(isOnDemand
      ? {}
      : {
          ProvisionedThroughput: {
            ReadCapacityUnits: 5,
            WriteCapacityUnits: 5,
          },
        }),
  };

  await ddb
    .updateTable({
      TableName: TABLE_NAME,
      AttributeDefinitions: [
        { AttributeName: "manifestId", AttributeType: "S" },
        { AttributeName: "createdAt", AttributeType: "S" },
      ],
      GlobalSecondaryIndexUpdates: [{ Create: createSpec }],
    })
    .promise();

  console.log("Submitted. GSI will backfill in the background.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
