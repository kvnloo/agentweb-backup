import { linkedInOutreachService } from "./linkedInOutreachService";
import { getAccountsByUserId } from "./connectedAccountsDb";

// ─── Types ──────────────────────────────────────────────────────────────

export interface UnipileAccountMetrics {
  accountId: string;
  accountName: string;
  messagesSent: number;
  repliesReceived: number;
  connectionRequestsSent: number;
}

export interface UnipileOutreachMetrics {
  totalMessagesSent: number;
  totalRepliesReceived: number;
  totalConnectionRequests: number;
  accountBreakdown: {
    accountName: string;
    messagesSent: number;
    repliesReceived: number;
  }[];
  status: "ok" | "error" | "unavailable";
  error?: string;
}

// ─── Constants ──────────────────────────────────────────────────────────

// User IDs known to have Unipile connected accounts
const UNIPILE_USER_IDS = [
  "1743956381327",                              // harsha@agentweb.pro
  "be754b6c-767e-44ec-b181-4042cfe45ea9",       // founders@agentweb.pro
];

// Safety cap: max messages pages to fetch per account to avoid API rate limits
const MAX_MESSAGE_PAGES = 10;

// ─── Helpers ────────────────────────────────────────────────────────────

function emptyMetrics(status: "error" | "unavailable", error?: string): UnipileOutreachMetrics {
  return {
    totalMessagesSent: 0,
    totalRepliesReceived: 0,
    totalConnectionRequests: 0,
    accountBreakdown: [],
    status,
    error,
  };
}

function parsePeriodDays(period: string): number {
  const match = period.match(/^(\d+)d$/);
  return match ? parseInt(match[1], 10) : 30;
}

/**
 * Discover all Unipile connected accounts across the known user IDs.
 * Returns a flat list of { accountId, accountName } for all platform='unipile' entries.
 */
async function discoverUnipileAccounts(): Promise<{ accountId: string; accountName: string }[]> {
  const discovered: { accountId: string; accountName: string }[] = [];
  const seenIds = new Set<string>();

  await Promise.all(
    UNIPILE_USER_IDS.map(async (userId) => {
      try {
        const accounts = await getAccountsByUserId(userId);
        for (const acc of accounts) {
          if (acc.platform === "unipile" && !seenIds.has(acc.account_id)) {
            seenIds.add(acc.account_id);
            discovered.push({
              accountId: acc.account_id,
              accountName: acc.account_name,
            });
          }
        }
      } catch (err: any) {
        console.warn(`[UnipileOutreach] Failed to fetch accounts for user ${userId}:`, err.message);
      }
    }),
  );

  return discovered;
}

/**
 * Fetch messaging metrics for a single Unipile account within the given date range.
 * Uses the Unipile SDK's getAllMessages with `after` filter and paginates through results.
 * Messages with is_sender=1 are sent, is_sender=0 are received (replies).
 */
async function fetchAccountMessageMetrics(
  accountId: string,
  afterDate: string,
): Promise<{ messagesSent: number; repliesReceived: number }> {
  let messagesSent = 0;
  let repliesReceived = 0;

  try {
    const client = await linkedInOutreachService.getClient();
    let cursor: string | undefined = undefined;
    let pages = 0;

    do {
      const params: any = cursor
        ? { cursor, limit: 100 }
        : { account_id: accountId, after: afterDate, limit: 100 };

      const result = await client.messaging.getAllMessages(params);

      if (result?.items) {
        for (const msg of result.items) {
          // Skip event messages (group changes, reactions, etc.)
          if (msg.is_event === 1) continue;

          if (msg.is_sender === 1) {
            messagesSent++;
          } else {
            repliesReceived++;
          }
        }
      }

      cursor = result?.cursor ?? undefined;
      pages++;
    } while (cursor && pages < MAX_MESSAGE_PAGES);
  } catch (err: any) {
    console.warn(`[UnipileOutreach] Failed to fetch messages for account ${accountId}:`, err.message);
  }

  return { messagesSent, repliesReceived };
}

/**
 * Fetch connection requests sent for a single Unipile account within the given date range.
 * The Unipile invitation API returns all pending invitations; we filter by parsed_datetime.
 */
async function fetchAccountConnectionRequests(
  accountId: string,
  afterDate: Date,
): Promise<number> {
  let count = 0;

  try {
    const client = await linkedInOutreachService.getClient();
    let cursor: string | undefined = undefined;
    let pages = 0;

    do {
      const params: any = { account_id: accountId, limit: 100 };
      if (cursor) params.cursor = cursor;

      const result = await client.users.getAllInvitationsSent(params);

      if (result?.items) {
        for (const inv of result.items) {
          // Filter by date if parsed_datetime is available
          const invDate = inv.parsed_datetime ? new Date(inv.parsed_datetime) : null;
          if (invDate && invDate >= afterDate) {
            count++;
          } else if (invDate && invDate < afterDate) {
            // Invitations are sorted newest-first; stop early if we've passed the date range
            return count;
          } else {
            // No date available — count it conservatively
            count++;
          }
        }
      }

      cursor = result?.cursor ?? undefined;
      pages++;
    } while (cursor && pages < MAX_MESSAGE_PAGES);
  } catch (err: any) {
    console.warn(`[UnipileOutreach] Failed to fetch invitations for account ${accountId}:`, err.message);
  }

  return count;
}

// ─── Main Function ──────────────────────────────────────────────────────

/**
 * Aggregate LinkedIn outreach metrics from all Unipile connected accounts.
 * @param period - Duration string like "30d", "7d", etc.
 */
export async function getUnipileOutreachMetrics(period: string): Promise<UnipileOutreachMetrics> {
  try {
    // Discover all Unipile accounts across known users
    const accounts = await discoverUnipileAccounts();

    if (accounts.length === 0) {
      return emptyMetrics("unavailable", "No Unipile accounts connected");
    }

    const days = parsePeriodDays(period);
    const afterDate = new Date();
    afterDate.setUTCDate(afterDate.getUTCDate() - days);
    afterDate.setUTCHours(0, 0, 0, 0);
    const afterDateStr = afterDate.toISOString();

    // Fetch metrics for all accounts in parallel
    const results = await Promise.all(
      accounts.map(async (acc) => {
        const [msgMetrics, connectionRequests] = await Promise.all([
          fetchAccountMessageMetrics(acc.accountId, afterDateStr),
          fetchAccountConnectionRequests(acc.accountId, afterDate),
        ]);

        return {
          accountId: acc.accountId,
          accountName: acc.accountName,
          messagesSent: msgMetrics.messagesSent,
          repliesReceived: msgMetrics.repliesReceived,
          connectionRequestsSent: connectionRequests,
        } as UnipileAccountMetrics;
      }),
    );

    // Aggregate
    let totalMessagesSent = 0;
    let totalRepliesReceived = 0;
    let totalConnectionRequests = 0;
    const accountBreakdown: UnipileOutreachMetrics["accountBreakdown"] = [];

    for (const r of results) {
      totalMessagesSent += r.messagesSent;
      totalRepliesReceived += r.repliesReceived;
      totalConnectionRequests += r.connectionRequestsSent;
      accountBreakdown.push({
        accountName: r.accountName,
        messagesSent: r.messagesSent,
        repliesReceived: r.repliesReceived,
      });
    }

    return {
      totalMessagesSent,
      totalRepliesReceived,
      totalConnectionRequests,
      accountBreakdown,
      status: "ok",
    };
  } catch (err: any) {
    console.error("[UnipileOutreach] Error fetching Unipile outreach metrics:", err.message);
    return emptyMetrics("error", err.message);
  }
}
