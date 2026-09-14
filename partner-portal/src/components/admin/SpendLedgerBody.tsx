import React from "react";
import {
  Alert,
  Box,
  Grid,
  LinearProgress,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from "@mui/material";
import InfoIcon from "@mui/icons-material/InfoOutlined";

/**
 * SpendLedgerBody — the cross-vendor spend ledger for one billing subject and
 * month (ENG-1838, rendering the ENG-1250 §7 read models).
 *
 * §7's requirement is blunt: *"No admin should need direct DynamoDB inspection
 * to explain a pause."* The API that satisfies it shipped in PR #2811 and
 * nothing rendered it, so the answer still lived in a table scan.
 *
 * ## Sibling of, not replacement for, the other two drill-ins
 *
 * `CostBreakdownBody` (LLM) and `XCostBreakdownBody` (X) both read the daily
 * aggregate table. This one reads the immutable `AW-SpendEvents` ledger, so it
 * is per-call rather than per-day, spans every metered vendor at once, and can
 * show reservations — which the aggregate has no concept of.
 *
 * ## Three rules this component exists to keep
 *
 * **A reservation is not spend.** Committed-but-unresolved money is reported
 * beside settled spend and never added into it. Merging them would overstate
 * what an account has actually consumed.
 *
 * **Raw spend, adjustments and usable balance are three figures, not one.**
 * ENG-1250 §3: *"Credits and migration adjustments change available allowance;
 * they never erase or rewrite spend."* A single net number would hide which of
 * the two moved.
 *
 * **Absence is stated, never rendered as zero.** A month with no events reads
 * as "nothing recorded", not "$0.00 spent" — the same distinction the customer
 * spend breakdown draws, and for the same reason.
 *
 * Read-only by construction: it takes a payload and renders it. ENG-1250 AC6
 * keeps enforcement with Harsha, and a read model must never become the thing
 * that pauses an account.
 */

/** One dimension's slice of the month, mirroring spendReadModel.SpendSlice. */
export interface SpendSlice {
  key: string;
  settledMicroUsd: number;
  reservedMicroUsd: number;
  eventCount: number;
  percentOfSettled: number;
}

export interface DailySpend {
  date: string;
  settledMicroUsd: number;
  reservedMicroUsd: number;
  eventCount: number;
}

export interface InFlightReservation {
  eventId: string;
  occurredAt: string;
  provider: string;
  operation: string;
  costMicroUsd: number;
  actingUserId: string;
}

/** Mirrors spendProjection.MonthlyProjection (the fields this surface reads). */
export interface MonthlyProjection {
  settledMicroUsd: number;
  reservedMicroUsd: number;
  includedAllowanceMicroUsd: number;
  purchasedCreditsMicroUsd: number;
  adminAdjustmentMicroUsd: number;
  migrationAdjustmentMicroUsd: number;
  usableAllowanceMicroUsd: number;
  remainingMicroUsd: number;
  overspentMicroUsd: number;
  unlimited: boolean;
  policyMode: string;
  policyModeError?: string;
  settledEventCount: number;
  reservedEventCount: number;
  voidedEventCount: number;
  excludedEventCount: number;
}

export interface PauseExplanation {
  paused: boolean;
  reason: string | null;
  settledMicroUsd: number;
  reservedMicroUsd: number;
  usableAllowanceMicroUsd: number;
  overspentMicroUsd: number;
  topProviders: SpendSlice[];
}

/** The GET /api/admin/users/:billingUserId/spend/breakdown payload. */
export interface SpendLedgerPayload {
  billingUserId: string;
  /** The id the admin actually opened — differs when they opened an org member. */
  requestedUserId?: string;
  billingMonth: string;
  daily: DailySpend[];
  byProvider: SpendSlice[];
  byFeature: SpendSlice[];
  byMember: SpendSlice[];
  bySession: SpendSlice[];
  inFlight: InFlightReservation[];
  inFlightMicroUsd: number;
  settledMicroUsd: number;
  eventCount: number;
  projection: MonthlyProjection;
  pause: PauseExplanation;
}

// ── Pure helpers, exported for unit tests ────────────────────────────────────

/**
 * Micro-dollars to a dollar string.
 *
 * Four decimals below a dollar because vendor units are genuinely sub-cent — an
 * X owned-read is $0.001 and an enrich.so validation $0.0005, so two decimals
 * would render real spend as "$0.00" on exactly the rows this screen exists to
 * itemise. Matches the sibling drill-ins.
 */
export function usdFromMicro(micro: number): string {
  const n = (micro || 0) / 1e6;
  const abs = Math.abs(n);
  // Sign outside the symbol. An admin reversal is a negative adjustment, and
  // `$-5.00` reads as a malformed figure rather than as money taken back.
  const sign = n < 0 ? "-" : "";
  return `${sign}$${abs.toFixed(abs < 1 && abs !== 0 ? 4 : 2)}`;
}

/**
 * Money an account has committed: settled plus in-flight.
 *
 * This is the figure a pause is measured against (ENG-1250 §4's admission basis
 * is settled + reserved), so showing settled alone next to the allowance would
 * make a pause look unexplained by its own numbers.
 */
export function committedMicroUsd(p: Pick<MonthlyProjection, "settledMicroUsd" | "reservedMicroUsd">): number {
  return p.settledMicroUsd + p.reservedMicroUsd;
}

/** A percentage of the allowance, or null when the tier is uncapped. */
export function committedPercent(projection: MonthlyProjection): number | null {
  if (projection.unlimited || projection.usableAllowanceMicroUsd <= 0) return null;
  return (committedMicroUsd(projection) / projection.usableAllowanceMicroUsd) * 100;
}

/** `2026-09-04T10:00:00.000Z` → `Sep 4, 10:00 UTC`. */
export function shortInstant(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const month = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${month} ${d.getUTCDate()}, ${hh}:${mm} UTC`;
}

const SLICE_TITLES: Record<string, { title: string; caption: string }> = {
  byProvider: { title: "By vendor", caption: "Which upstream the money went to" },
  byFeature: { title: "By feature", caption: "Which product surface spent it" },
  byMember: { title: "By member", caption: "Who triggered the calls — the acting user, not the payer" },
  bySession: { title: "By session", caption: "Which run or chat it belonged to" },
};

/**
 * Rows rendered per cut before the tail is summarised.
 *
 * `bySession` is one row per session in the month and `inFlight` one per open
 * reservation — both unbounded for a busy billing root, unlike `daily` (~31),
 * `byProvider` (the vendor set) and `byFeature`. Rendering thousands of rows in
 * a modal is a slow render, not wrong data, so the tail is COUNTED rather than
 * dropped: an omitted row that nothing mentions would make the visible rows
 * look like the whole month (CodeRabbit, PR #2843).
 */
export const MAX_ROWS_PER_CUT = 25;

const SliceTable: React.FC<{ id: string; rows: SpendSlice[] }> = ({ id, rows }) => {
  const meta = SLICE_TITLES[id];
  const max = Math.max(...rows.map((r) => r.settledMicroUsd + r.reservedMicroUsd), 0);
  const shown = rows.slice(0, MAX_ROWS_PER_CUT);
  const hidden = rows.length - shown.length;

  return (
    <Box sx={{ mb: 2 }} data-testid={`spend-slice-${id}`}>
      <Typography variant="subtitle2" fontWeight={600}>
        {meta.title}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {meta.caption}
      </Typography>
      {rows.length === 0 ? (
        // Stated, not rendered as an empty table — an empty grid reads as
        // "nothing spent here" rather than "this cut has nothing to show".
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          Nothing recorded for this cut.
        </Typography>
      ) : (
        <Table size="small" sx={{ mt: 0.5 }}>
          <TableHead>
            <TableRow>
              <TableCell>{meta.title.replace("By ", "")}</TableCell>
              <TableCell align="right">Events</TableCell>
              <TableCell align="right">Settled</TableCell>
              <TableCell align="right">In-flight</TableCell>
              <TableCell align="right">Share</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {shown.map((r) => (
              <TableRow key={r.key} hover>
                <TableCell>
                  {r.key}
                  <LinearProgress
                    variant="determinate"
                    value={max > 0 ? ((r.settledMicroUsd + r.reservedMicroUsd) / max) * 100 : 0}
                    sx={{ height: 4, borderRadius: 1, mt: 0.5 }}
                  />
                </TableCell>
                <TableCell align="right" sx={{ fontVariantNumeric: "tabular-nums" }}>
                  {r.eventCount.toLocaleString()}
                </TableCell>
                <TableCell align="right" sx={{ fontVariantNumeric: "tabular-nums" }}>
                  {usdFromMicro(r.settledMicroUsd)}
                </TableCell>
                <TableCell align="right" sx={{ fontVariantNumeric: "tabular-nums" }}>
                  {r.reservedMicroUsd > 0 ? usdFromMicro(r.reservedMicroUsd) : "—"}
                </TableCell>
                <TableCell align="right" sx={{ fontVariantNumeric: "tabular-nums" }}>
                  {r.percentOfSettled.toFixed(1)}%
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {hidden > 0 && (
        <Typography variant="caption" color="text.secondary" data-testid={`spend-slice-${id}-more`}>
          Showing the {MAX_ROWS_PER_CUT} largest of {rows.length.toLocaleString()} — {hidden.toLocaleString()} more
          not shown, but included in every total above.
        </Typography>
      )}
    </Box>
  );
};

export const SpendLedgerBody: React.FC<{ data: SpendLedgerPayload | null }> = ({ data }) => {
  if (!data) return null;

  const { projection, pause } = data;
  const openedAMember = !!data.requestedUserId && data.requestedUserId !== data.billingUserId;
  const nothingRecorded = data.eventCount === 0;

  return (
    <Box data-testid="spend-ledger">
      {/* Whose ledger this is. An admin who drilled in from a per-user row may
          have opened an org MEMBER; the ledger is partitioned by billing root,
          so what they are reading is the org's spend, not that member's. Saying
          nothing here would let an org-wide figure read as one person's. */}
      {openedAMember && (
        <Alert severity="info" sx={{ mb: 2 }} data-testid="spend-ledger-billing-subject">
          Showing the billing owner's ledger (<code>{data.billingUserId}</code>) — the user you
          opened (<code>{data.requestedUserId}</code>) pools onto it, so these figures are org-wide.
        </Alert>
      )}

      {projection.policyModeError && (
        <Alert severity="warning" sx={{ mb: 2 }} data-testid="spend-ledger-policy-error">
          This account's stored usage policy could not be evaluated, so the state below is a
          default rather than a measurement: {projection.policyModeError}
        </Alert>
      )}

      {projection.excludedEventCount > 0 && (
        <Alert severity="warning" sx={{ mb: 2 }} data-testid="spend-ledger-excluded">
          {projection.excludedEventCount.toLocaleString()} ledger event
          {projection.excludedEventCount === 1 ? "" : "s"} belonged to another subject or month and
          were excluded. This should be zero — the figures below may be incomplete.
        </Alert>
      )}

      {/* ENG-1874. The pause explanation is WITHHELD, not merely hidden.
          `explainPause` compares committed spend against the usable allowance,
          and those two have different bases today: the ledger holds vendor
          spend only (no LLM row has ever been written to AW-SpendEvents — both
          writers sit inside recordVendorUsage), while the allowance is the
          tier's LLM cost cap. A pause claim built on that is not a weaker
          answer, it is a wrong one, and this screen exists precisely to be
          trusted about pauses. Restore it with ENG-1250 §6, when LLM rows reach
          the ledger and the two sides finally describe the same thing. */}

      {/* Raw spend, what is committed but unresolved, and what the account may
          actually spend — three figures, never netted into one (ENG-1250 §3). */}
      <Grid container spacing={2} sx={{ mb: 2 }}>
        <Grid item xs={12} md={3}>
          <Box sx={{ border: 1, borderColor: "divider", borderRadius: 1, p: 1.5 }}>
            <Typography variant="caption" color="text.secondary">
              Settled spend
            </Typography>
            <Typography variant="h6" data-testid="spend-ledger-settled" sx={{ fontVariantNumeric: "tabular-nums" }}>
              {usdFromMicro(data.settledMicroUsd)}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {projection.settledEventCount.toLocaleString()} events
            </Typography>
          </Box>
        </Grid>
        <Grid item xs={12} md={3}>
          <Box sx={{ border: 1, borderColor: "divider", borderRadius: 1, p: 1.5 }}>
            <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
              <Typography variant="caption" color="text.secondary">
                In-flight
              </Typography>
              <Tooltip
                title="Reservations: money committed to a call that has not settled or been voided yet. Counted against admission, but it is not spend — it is never added into the settled figure."
                arrow
              >
                <InfoIcon sx={{ fontSize: 14, color: "text.disabled", cursor: "help" }} />
              </Tooltip>
            </Box>
            <Typography variant="h6" data-testid="spend-ledger-inflight" sx={{ fontVariantNumeric: "tabular-nums" }}>
              {usdFromMicro(data.inFlightMicroUsd)}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {projection.reservedEventCount.toLocaleString()} reservations
            </Typography>
          </Box>
        </Grid>
      </Grid>

      {/* What is NOT shown here, and why — ENG-1874.

          Usable allowance, remaining, and "% of allowance committed" used to
          sit beside the two figures above. They were removed because the
          comparison is invalid, not because it is unavailable: the numerator
          (this ledger) is vendor spend only, and the denominator (the tier's
          cost cap) is sized for LLM spend too. The result rendered "0.0% of
          allowance committed" for accounts that had consumed most of that cap.

          Saying nothing would leave an admin to assume the omission is a bug.
          Saying this costs one line and is true. */}
      <Alert severity="info" sx={{ mb: 2 }} data-testid="spend-ledger-basis-note">
        This ledger currently records <strong>vendor spend only</strong> — LLM usage is metered on
        a separate rail and does not appear here. Allowance and remaining-balance figures are
        withheld for that reason: comparing this total against a cap that also covers LLM spend
        would understate how much of the cap is used.
      </Alert>

      {/* Allowance adjustments (purchased credits, admin grants, migration
          offset) were rendered here until ENG-1874 and are withheld with the
          allowance itself: an adjustment shown next to no balance invites the
          reader to reconstruct the very comparison this change removes.

          The principle they encode survives for whoever restores them — they
          raise what the account MAY spend and never reduce what it HAS spent
          (ENG-1250 §3), so a single net figure would make those two
          indistinguishable. */}

      {nothingRecorded ? (
        // "No events" and "$0.00 spent" are different claims and only one of
        // them is true here. The ledger began writing on 2026-09-07, so an
        // earlier month legitimately has nothing to show.
        <Alert severity="info" data-testid="spend-ledger-empty">
          No spend recorded in the ledger for this billing subject in {data.billingMonth}. That is
          not the same as $0.00 spent — this ledger only covers calls made after it started
          recording.
        </Alert>
      ) : (
        <>
          {data.inFlight.length > 0 && (
            <Box sx={{ mb: 2 }} data-testid="spend-ledger-inflight-table">
              <Typography variant="subtitle2" fontWeight={600}>
                Open reservations
              </Typography>
              <Typography variant="caption" color="text.secondary">
                Committed and not yet resolved. A pause has to be explained against these as much
                as against settled spend.
              </Typography>
              <Table size="small" sx={{ mt: 0.5 }}>
                <TableHead>
                  <TableRow>
                    <TableCell>When</TableCell>
                    <TableCell>Vendor / operation</TableCell>
                    <TableCell>Acting user</TableCell>
                    <TableCell align="right">Amount</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {data.inFlight.slice(0, MAX_ROWS_PER_CUT).map((r) => (
                    <TableRow key={r.eventId} hover>
                      <TableCell>{shortInstant(r.occurredAt)}</TableCell>
                      <TableCell>
                        {r.provider}
                        <Typography component="span" variant="caption" color="text.secondary">
                          {" "}
                          {r.operation}
                        </Typography>
                      </TableCell>
                      <TableCell>{r.actingUserId}</TableCell>
                      <TableCell align="right" sx={{ fontVariantNumeric: "tabular-nums" }}>
                        {usdFromMicro(r.costMicroUsd)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {data.inFlight.length > MAX_ROWS_PER_CUT && (
                <Typography variant="caption" color="text.secondary" data-testid="spend-ledger-inflight-more">
                  Showing the {MAX_ROWS_PER_CUT} most recent of{" "}
                  {data.inFlight.length.toLocaleString()} open reservations —{" "}
                  {(data.inFlight.length - MAX_ROWS_PER_CUT).toLocaleString()} more not shown, but the
                  in-flight total above counts all of them.
                </Typography>
              )}
            </Box>
          )}

          <SliceTable id="byProvider" rows={data.byProvider} />
          <SliceTable id="byFeature" rows={data.byFeature} />
          <SliceTable id="byMember" rows={data.byMember} />
          <SliceTable id="bySession" rows={data.bySession} />

          {data.daily.length > 0 && (
            <Box data-testid="spend-ledger-daily">
              <Typography variant="subtitle2" fontWeight={600}>
                Daily
              </Typography>
              <Table size="small" sx={{ mt: 0.5 }}>
                <TableHead>
                  <TableRow>
                    <TableCell>Date</TableCell>
                    <TableCell align="right">Events</TableCell>
                    <TableCell align="right">Settled</TableCell>
                    <TableCell align="right">In-flight</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {data.daily.map((d) => (
                    <TableRow key={d.date} hover>
                      <TableCell>{d.date}</TableCell>
                      <TableCell align="right" sx={{ fontVariantNumeric: "tabular-nums" }}>
                        {d.eventCount.toLocaleString()}
                      </TableCell>
                      <TableCell align="right" sx={{ fontVariantNumeric: "tabular-nums" }}>
                        {usdFromMicro(d.settledMicroUsd)}
                      </TableCell>
                      <TableCell align="right" sx={{ fontVariantNumeric: "tabular-nums" }}>
                        {d.reservedMicroUsd > 0 ? usdFromMicro(d.reservedMicroUsd) : "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Box>
          )}
        </>
      )}
    </Box>
  );
};

export default SpendLedgerBody;
