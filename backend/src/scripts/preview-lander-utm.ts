/** ENG-728: read-only operator entry point. No apply/write capability. */
import AWS from 'aws-sdk';
import { readFile } from 'fs/promises';
import { previewLanderUtmRedecoration, type PreviewLanderRecord, type LanderUtmPreviewResult } from '../services/landerUtmRedecoratePreview';
import { validateUtmConfig } from '../utils/landerUtm';

interface Readers {
  db: Pick<AWS.DynamoDB.DocumentClient, 'query'>;
  getUser(userId: string): Promise<any>;
  readSnapshot(path: string): Promise<any>;
}

/**
 * Run on the production release with read-only AWS credentials and a captured
 * deployed-link inventory. The inventory is deliberately explicit: do not crawl
 * arbitrary customer URLs, execute page scripts, or infer links from latest main.
 * Missing/corrupt entries remain error rows, never an empty successful preview.
 */
export async function runLanderUtmPreview(args: string[], deps: Readers): Promise<LanderUtmPreviewResult> {
  const [userId, snapshotPath, ...selectedLanderIds] = args;
  if (!userId || !snapshotPath || args.some(arg => arg.startsWith('--'))) {
    throw new Error('Usage: preview-lander-utm <userId> <deployed-links.json> [explicit-override-lander-id ...]; preview only');
  }
  const snapshot = await deps.readSnapshot(snapshotPath);
  if (!snapshot || snapshot.userId !== userId || !snapshot.landers || typeof snapshot.landers !== 'object' || Array.isArray(snapshot.landers)) {
    throw new Error('Deployed-link inventory must have the requested userId and a landers object');
  }
  const missingRecords = new Set<string>();
  return previewLanderUtmRedecoration({ userId, selectedLanderIds }, {
    listLanders: async () => {
      const rows: PreviewLanderRecord[] = [];
      let cursor: AWS.DynamoDB.DocumentClient.Key | undefined;
      do {
        const page = await deps.db.query({
          TableName: `${process.env.NODE_ENV === 'development' ? 'Dev-' : ''}AW-LandingPages`,
          IndexName: 'UserIdIndex',
          KeyConditionExpression: 'userId = :userId',
          ExpressionAttributeValues: { ':userId': userId },
          ...(cursor ? { ExclusiveStartKey: cursor } : {}),
        }).promise();
        for (const row of page.Items ?? []) {
          if (row.userId !== userId || typeof row.id !== 'string' || !row.id || typeof row.status !== 'string') {
            throw new Error('Corrupt or foreign landing-page inventory record');
          }
          rows.push(row as PreviewLanderRecord);
        }
        cursor = page.LastEvaluatedKey;
      } while (cursor);
      // Explicitly requested but missing records must not vanish from output.
      for (const id of selectedLanderIds) {
        if (!rows.some(row => row.id === id)) {
          missingRecords.add(id);
          rows.push({ id, userId, name: id, status: 'deployed' });
        }
      }
      return rows;
    },
    getCustomerDefault: async () => {
      const user = await deps.getUser(userId);
      if (!user || user.userId !== userId) throw new Error('Customer record is missing or foreign');
      return user.landerUtmDefault === undefined ? null : validateUtmConfig(user.landerUtmDefault, 'customer default');
    },
    readDeployedLinks: async lander => {
      if (missingRecords.has(lander.id)) throw new Error('Landing-page record is missing');
      return Object.prototype.hasOwnProperty.call(snapshot.landers, lander.id) ? snapshot.landers[lander.id] : null;
    },
  });
}

if (require.main === module) {
  // Lazy-load only in the real CLI, keeping the injected invocation pure in tests.
  const { userDb } = require('../services/db');
  runLanderUtmPreview(process.argv.slice(2), {
    db: new AWS.DynamoDB.DocumentClient({ region: process.env.AWS_REGION || 'us-west-2', httpOptions: { timeout: 30000, connectTimeout: 5000 } }),
    getUser: userDb.getUserById.bind(userDb),
    readSnapshot: async path => JSON.parse(await readFile(path, 'utf8')),
  }).then(result => {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (result.summary.errors) process.exitCode = 1;
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
