import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config } from "./config.js";
import { ACTIVITY_TYPES, type WiseService } from "./wise/service.js";
import { WiseAccessRevokedError } from "./wise/client.js";
import { storePending, takePending, discardPending } from "./pending.js";

const ok = (data: unknown) => ({
  content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
});
const fail = (message: string) => ({ content: [{ type: "text" as const, text: message }], isError: true });

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/, "Use YYYY-MM-DD or an ISO 8601 timestamp");
const profileArg = z
  .union([z.string(), z.number().int()])
  .optional()
  .describe('Profile id from list_profiles, "personal", "business" or part of the profile name');
const READ = { readOnlyHint: true, openWorldHint: false } as const;
const currency = z.string().regex(/^[A-Za-z]{3}$/, "3-letter currency code").transform((c) => c.toUpperCase());
const money = (n: number | undefined, c: string | undefined) => (n === undefined ? "?" : `${n.toFixed(2)} ${c ?? ""}`.trim());

async function audit(event: string, details: Record<string, unknown>) {
  const line = JSON.stringify({ at: new Date().toISOString(), event, ...details }) + "\n";
  await appendFile(path.join(config.DATA_DIR, "audit.log"), line, { mode: 0o600 }).catch(() => {});
}

/**
 * `sessionKey` scopes confirmation codes (a code only works in the session that prepared it);
 * `connectionId` identifies the Wise token in the audit log.
 */
export function registerTools(
  server: McpServer,
  wise: WiseService,
  { sessionKey, connectionId, onRevoked }: { sessionKey: string; connectionId: string; onRevoked: () => Promise<void> },
) {
  async function safe<T>(fn: () => Promise<T>) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof WiseAccessRevokedError) await onRevoked();
      return fail(err instanceof Error ? err.message : String(err));
    }
  }

  server.registerTool(
    "list_profiles",
    {
      title: "List Wise profiles",
      description: "List the Wise profiles (personal and business) this token can access, with id, type and name.",
      inputSchema: {},
      annotations: READ,
    },
    async () => safe(async () => ok(await wise.listProfiles())),
  );

  server.registerTool(
    "list_balances",
    {
      title: "List Wise balances",
      description:
        "Current balances in every currency plus Jars (savings), with amounts. Default: all profiles. " +
        "Empty balances are hidden unless include_empty is true.",
      inputSchema: {
        profile: profileArg.describe('Profile id, "personal", "business", part of the name, or "all" (default)'),
        include_empty: z.boolean().optional().describe("Also list balances with 0"),
      },
      annotations: READ,
    },
    async ({ profile, include_empty }) =>
      safe(async () => ok(await wise.listBalances(await wise.resolveProfiles(profile), include_empty ?? false))),
  );

  server.registerTool(
    "get_transactions",
    {
      title: "Get Wise transactions",
      description:
        "List activity on a Wise profile, newest first: card payments, transfers, conversions, cashback, direct debits. " +
        "Amounts are positive numbers; `direction` is in/out/neutral (neutral = between your own balances). " +
        "`title` is the merchant or counterparty. Filter with `type`, `since`/`until` (YYYY-MM-DD, UTC) and `search`. " +
        "If `next_cursor` is returned, pass it as `cursor` (with the same filters) for older results. " +
        "Use `resource.id` of TRANSFER items with get_transfer for details. Default profile: personal.",
      inputSchema: {
        profile: profileArg,
        type: z
          .string()
          .optional()
          .describe(`One of ${Object.keys(ACTIVITY_TYPES).join(", ")}, or a raw Wise monetaryResourceType (e.g. CARD_TRANSACTION)`),
        status: z.enum(["COMPLETED", "IN_PROGRESS", "UPCOMING", "REQUIRES_ATTENTION", "CANCELLED"]).optional(),
        since: date.optional().describe("Only on/after this date (YYYY-MM-DD or ISO timestamp)"),
        until: date.optional().describe("Only on/before this date (YYYY-MM-DD or ISO timestamp)"),
        search: z
          .string()
          .optional()
          .describe("Case-insensitive text match on merchant/title/description (scans up to 2000 items; may return slightly more than limit)"),
        limit: z.number().int().min(1).max(500).optional().describe("Max items (default 50)"),
        cursor: z.string().optional().describe("next_cursor from a previous call"),
      },
      annotations: READ,
    },
    async (args) =>
      safe(async () => {
        const profile = await wise.resolveProfile(args.profile);
        const resourceType = args.type ? (ACTIVITY_TYPES[args.type.toLowerCase()] ?? args.type.toUpperCase()) : undefined;
        const { activities, nextCursor } = await wise.listActivities({
          profile,
          limit: args.limit ?? 50,
          since: args.since,
          until: args.until,
          resourceType,
          status: args.status,
          search: args.search,
          cursor: args.cursor,
        });
        return ok({ profile, count: activities.length, transactions: activities, next_cursor: nextCursor });
      }),
  );

  server.registerTool(
    "list_transfers",
    {
      title: "List Wise transfers",
      description:
        "Transfers (money sent or converted) on a profile, newest first, with both currencies, reference, status and recipient name. " +
        "Filter by date (YYYY-MM-DD), status (e.g. outgoing_payment_sent, processing, cancelled) or search (reference/recipient). Default profile: personal.",
      inputSchema: {
        profile: profileArg,
        since: date.optional(),
        until: date.optional(),
        status: z.string().optional().describe("Wise transfer status, e.g. outgoing_payment_sent"),
        search: z.string().optional().describe("Case-insensitive match on reference or recipient name"),
        limit: z.number().int().min(1).max(200).optional().describe("Max transfers (default 25)"),
      },
      annotations: READ,
    },
    async (args) =>
      safe(async () => {
        const profile = await wise.resolveProfile(args.profile);
        const res = await wise.listTransfers({ profile, limit: args.limit ?? 25, since: args.since, until: args.until, status: args.status, search: args.search });
        return ok({ profile, ...res });
      }),
  );

  server.registerTool(
    "get_transfer",
    {
      title: "Get a Wise transfer",
      description: "Details of one transfer: amounts in both currencies, rate, reference, status, created date and recipient.",
      inputSchema: { id: z.coerce.number().int().describe("Transfer id (from list_transfers or a TRANSFER activity's resource.id)") },
      annotations: READ,
    },
    async ({ id }) => safe(async () => ok(await wise.getTransfer(id))),
  );

  server.registerTool(
    "list_recipients",
    {
      title: "List Wise recipients",
      description: "Saved recipients (name, currency, account type, account number/IBAN). Default: all profiles.",
      inputSchema: {
        profile: profileArg.describe('Profile id, "personal", "business", part of the name, or "all" (default)'),
        currency: currency.optional().describe("Only recipients in this currency, e.g. EUR"),
        search: z.string().optional().describe("Case-insensitive match on name or account"),
      },
      annotations: READ,
    },
    async ({ profile, currency, search }) =>
      safe(async () => {
        const s = search?.trim().toLowerCase();
        const all = await wise.listRecipients(await wise.resolveProfiles(profile), currency);
        const recipients = s ? all.filter((r) => [r.name, r.account, r.details].some((v) => v?.toLowerCase().includes(s))) : all;
        return ok({ count: recipients.length, recipients });
      }),
  );

  server.registerTool(
    "get_exchange_rate",
    {
      title: "Get Wise exchange rate",
      description: "Wise's mid-market rate between two currencies, now or at a past date/time.",
      inputSchema: {
        source: currency.describe("Source currency, e.g. EUR"),
        target: currency.describe("Target currency, e.g. RON"),
        at: date.optional().describe("Historic rate at this date/time (default: now)"),
      },
      annotations: READ,
    },
    async ({ source, target, at }) => safe(async () => ok(await wise.getRate(source, target, at))),
  );

  if (config.WRITES_ENABLED) registerWriteTools(server, wise, { sessionKey, connectionId }, safe);
}

// -----------------------------------------------------------------------------
// Write tools: every action is prepare → user approves in chat → confirm_action.
// -----------------------------------------------------------------------------
const TWO_STEP =
  "Nothing is written to Wise yet: this returns a summary and a one-time confirmation_code. Show the summary to the user and " +
  "call confirm_action ONLY if the user explicitly approves it in their next message.";

function registerWriteTools(
  server: McpServer,
  wise: WiseService,
  { sessionKey, connectionId }: { sessionKey: string; connectionId: string },
  safe: <T>(fn: () => Promise<T>) => Promise<T | ReturnType<typeof fail>>,
) {
  const log = (event: string, details: Record<string, unknown>) => audit(event, { connection: connectionId, ...details });
  const limitText = config.MAX_TRANSFER_AMOUNT ? ` Max ${config.MAX_TRANSFER_AMOUNT} (source currency) per transfer.` : "";

  server.registerTool(
    "get_quote",
    {
      title: "Get a Wise quote",
      description:
        "Price a transfer or conversion: rate, fee, amount received and estimated delivery. Creates nothing the user sees and moves no money. " +
        "Give either send_amount (in source_currency) or receive_amount (in target_currency).",
      inputSchema: {
        source_currency: currency,
        target_currency: currency,
        send_amount: z.number().positive().optional(),
        receive_amount: z.number().positive().optional(),
        recipient_id: z.number().int().optional().describe("Saved recipient, for an exact price and delivery time"),
        profile: profileArg,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (a) =>
      safe(async () => {
        if (!!a.send_amount === !!a.receive_amount) return fail("Give exactly one of send_amount or receive_amount.");
        const profile = await wise.resolveProfile(a.profile);
        return ok(
          await wise.createQuote(profile, {
            sourceCurrency: a.source_currency,
            targetCurrency: a.target_currency,
            sourceAmount: a.send_amount,
            targetAmount: a.receive_amount,
            targetAccount: a.recipient_id,
          }),
        );
      }),
  );

  server.registerTool(
    "get_recipient_requirements",
    {
      title: "Get Wise recipient fields",
      description:
        "Which bank details Wise needs to add a recipient in a currency (e.g. IBAN for EUR, sort code + account number for GBP). " +
        "Each option has a `type` and `fields` (key, required, example, allowed values). Use before prepare_recipient.",
      inputSchema: {
        currency: currency.describe("Recipient's currency"),
        source_currency: currency.optional().describe("Currency you'll send from (default: same as currency)"),
        amount: z.number().positive().optional().describe("Typical amount (default 100); some routes depend on it"),
        profile: profileArg,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (a) =>
      safe(async () => {
        const profile = await wise.resolveProfile(a.profile);
        return ok(await wise.recipientRequirements(profile, a.source_currency ?? a.currency, a.currency, a.amount ?? 100));
      }),
  );

  server.registerTool(
    "prepare_recipient",
    {
      title: "Prepare a new Wise recipient",
      description:
        `Step 1 of 2 to save a new recipient. Use get_recipient_requirements first for the right \`type\` and \`details\` keys. ${TWO_STEP}`,
      inputSchema: {
        currency,
        type: z.string().min(1).describe("Requirement type, e.g. iban, sort_code, aba"),
        account_holder_name: z.string().min(2).describe("Recipient's full name or business name"),
        details: z
          .record(z.string(), z.unknown())
          .describe('Fields from get_recipient_requirements, e.g. {"legalType":"PRIVATE","iban":"DE89..."}; nested keys like address.city as objects'),
        owned_by_me: z.boolean().optional().describe("True if this is the user's own account elsewhere"),
        profile: profileArg,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (a) =>
      safe(async () => {
        const profile = await wise.resolveProfile(a.profile);
        const name = a.account_holder_name.trim();
        const shown = Object.entries(a.details)
          .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
          .join(", ");
        const summary = `Add ${a.currency} recipient "${name}" (${a.type}: ${shown}) to ${profile.type.toLowerCase()} profile ${profile.id}`;
        const { code, expiresAt } = storePending(
          sessionKey,
          { kind: "recipient", profileId: profile.id, currency: a.currency, type: a.type, accountHolderName: name, ownedByCustomer: a.owned_by_me, details: a.details },
          summary,
        );
        await log("recipient_prepared", { code, summary });
        return ok({ status: "awaiting_user_confirmation", summary, confirmation_code: code, expires_at: expiresAt.toISOString() });
      }),
  );

  server.registerTool(
    "prepare_transfer",
    {
      title: "Prepare a Wise transfer",
      description:
        "Step 1 of 2 to send money to a saved recipient (list_recipients / prepare_recipient). Gets a live quote and checks Wise's requirements. " +
        `${TWO_STEP} Confirming creates the transfer in Wise UNPAID: the user then pays it in the Wise app, so money only moves after that.${limitText}`,
      inputSchema: {
        recipient_id: z.number().int().describe("Saved recipient id"),
        send_amount: z.number().positive().optional().describe("Amount to send, in source_currency"),
        receive_amount: z.number().positive().optional().describe("Amount the recipient should get, in their currency"),
        source_currency: currency.optional().describe("Currency to send from (default: the recipient's currency)"),
        reference: z.string().max(140).optional().describe("Reference the recipient sees (max length depends on the route)"),
        extra_details: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Extra fields Wise requires on some routes, e.g. transferPurpose, sourceOfFunds (a previous attempt lists them)"),
        profile: profileArg.describe("Default: the profile the recipient belongs to"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (a) =>
      safe(async () => {
        if (!!a.send_amount === !!a.receive_amount) return fail("Give exactly one of send_amount or receive_amount.");
        const recipient = await wise.getRecipient(a.recipient_id);
        if (recipient.active === false) return fail(`Recipient ${a.recipient_id} is inactive.`);
        const profile = await wise.resolveProfile(a.profile ?? recipient.profile_id);
        const sourceCurrency = a.source_currency ?? recipient.currency;
        if (a.send_amount && config.MAX_TRANSFER_AMOUNT && a.send_amount > config.MAX_TRANSFER_AMOUNT) {
          return fail(`Amount exceeds the configured limit of ${config.MAX_TRANSFER_AMOUNT} ${sourceCurrency} per transfer.`);
        }

        const quote = await wise.createQuote(profile, {
          sourceCurrency,
          targetCurrency: recipient.currency,
          sourceAmount: a.send_amount,
          targetAmount: a.receive_amount,
          targetAccount: recipient.id,
        });
        if (config.MAX_TRANSFER_AMOUNT && quote.source.amount > config.MAX_TRANSFER_AMOUNT) {
          return fail(`This transfer costs ${money(quote.source.amount, sourceCurrency)}, over the configured limit of ${config.MAX_TRANSFER_AMOUNT}.`);
        }

        const details: Record<string, unknown> = { ...(a.extra_details ?? {}) };
        if (a.reference?.trim()) details.reference = a.reference.trim();
        const missing = await wise.missingTransferFields(quote.id, recipient.id, details);
        if (missing.length) {
          return fail(
            "Wise needs more details for this transfer. Ask the user, then call prepare_transfer again with extra_details: " +
              JSON.stringify(missing.map((f) => ({ key: f.key, name: f.name, allowed: f.allowed?.map((v: { key: string }) => v.key) }))),
          );
        }

        const balances = await wise.listBalances([profile], true);
        const balance = balances.find((b) => b.kind === "balance" && b.currency === sourceCurrency);
        const available = balance ? Number(balance.amount) : 0;

        const summary =
          `Send ${money(quote.source.amount, sourceCurrency)} from your ${profile.type.toLowerCase()} profile → ` +
          `${recipient.name} (${recipient.account ?? recipient.type}) receives ${money(quote.target.amount, recipient.currency)}` +
          (quote.fee ? `, fee ${money(quote.fee.amount, sourceCurrency)}` : "") +
          (sourceCurrency !== recipient.currency ? `, rate ${quote.rate}` : "") +
          (details.reference ? `, reference "${details.reference}"` : "") +
          (quote.delivery ? `, ${stripHtml(quote.delivery)}` : "");
        const { code, expiresAt } = storePending(
          sessionKey,
          {
            kind: "transfer",
            profileId: profile.id,
            quoteId: quote.id,
            targetAccount: recipient.id,
            customerTransactionId: randomUUID(),
            details,
            expected: { amount: quote.source.amount, currency: sourceCurrency },
          },
          summary,
        );
        await log("transfer_prepared", { code, summary });
        return ok({
          status: "awaiting_user_confirmation",
          summary,
          quote,
          balance_check:
            available >= quote.source.amount
              ? `OK: ${money(available, sourceCurrency)} available`
              : `Not enough ${sourceCurrency} balance (${money(available, sourceCurrency)}); the user can still pay another way in the Wise app`,
          confirmation_code: code,
          expires_at: expiresAt.toISOString(),
          next_step: "Show the summary. Only call confirm_action if the user explicitly approves. Afterwards they pay it in the Wise app.",
        });
      }),
  );

  server.registerTool(
    "prepare_cancel_transfer",
    {
      title: "Prepare cancelling a Wise transfer",
      description: `Step 1 of 2 to cancel a transfer that hasn't been paid yet (status incoming_payment_waiting). ${TWO_STEP}`,
      inputSchema: { transfer_id: z.coerce.number().int() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ transfer_id }) =>
      safe(async () => {
        const t = await wise.getTransfer(transfer_id);
        if (t.status !== "incoming_payment_waiting") {
          return fail(`Transfer ${transfer_id} is "${t.status}"; Wise only allows cancelling unpaid transfers (incoming_payment_waiting) via API.`);
        }
        const summary =
          `Cancel transfer ${t.id}: ${money(t.source.amount, t.source.currency)} → ${t.recipient?.name ?? `recipient ${t.recipient_id}`} ` +
          `(${money(t.target.amount, t.target.currency)})${t.reference ? `, reference "${t.reference}"` : ""}, created ${t.created}`;
        const { code, expiresAt } = storePending(sessionKey, { kind: "cancel_transfer", transferId: t.id }, summary);
        await log("cancel_prepared", { code, summary });
        return ok({ status: "awaiting_user_confirmation", summary, confirmation_code: code, expires_at: expiresAt.toISOString() });
      }),
  );

  server.registerTool(
    "confirm_action",
    {
      title: "Confirm a prepared Wise action",
      description:
        "Step 2 of 2: performs a transfer, new recipient or cancellation prepared with a prepare_* tool. ONLY call this after the user has " +
        "explicitly approved that exact summary in their latest message. Codes are single-use and expire after 10 minutes. " +
        "Transfers are created unpaid: the user pays them in the Wise app.",
      inputSchema: { confirmation_code: z.string().describe("Code from a prepare_* tool, e.g. TX-1A2B3C4D") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ confirmation_code }) =>
      safe(async () => {
        const p = takePending(sessionKey, confirmation_code);
        if (!p) return fail("Unknown or expired confirmation code. Prepare the action again.");
        const a = p.action;
        try {
          if (a.kind === "transfer") {
            const t = await wise.createTransfer({ targetAccount: a.targetAccount, quoteId: a.quoteId, customerTransactionId: a.customerTransactionId, details: a.details });
            // Wise has been seen creating a transfer for a different amount than its own quote. Never leave the
            // user with a transfer they didn't approve: it's still unpaid, so cancel it and say what happened.
            const got = { amount: Number(t.source.amount), currency: String(t.source.currency ?? "").toUpperCase() };
            if (Math.abs(got.amount - a.expected.amount) > 0.005 || got.currency !== a.expected.currency.toUpperCase()) {
              const cancelled = await wise.cancelTransfer(t.id).then(
                (c) => c.status,
                (err) => `cancel failed: ${err instanceof Error ? err.message : err}`,
              );
              await log("transfer_amount_mismatch", {
                code: confirmation_code,
                summary: p.summary,
                transfer_id: t.id,
                quote_id: a.quoteId,
                expected: a.expected,
                got,
                cancelled,
              });
              return fail(
                `Wise created transfer ${t.id} for ${money(got.amount, got.currency)} instead of the approved ` +
                  `${money(a.expected.amount, a.expected.currency)} (quote ${a.quoteId}). ` +
                  (cancelled === "cancelled"
                    ? "It was cancelled automatically, so nothing will be paid. "
                    : `Automatic cancellation didn't succeed (${cancelled}): tell the user to cancel it in the Wise app and NOT pay it. `) +
                  "Don't retry; tell the user this is a Wise-side mismatch.",
              );
            }
            await log("transfer_created", { code: confirmation_code, summary: p.summary, transfer_id: t.id, status: t.status });
            return ok({
              status: "created_awaiting_payment",
              transfer_id: t.id,
              wise_status: t.status,
              summary: p.summary,
              next_step: "Open the Wise app (or wise.com): the transfer is waiting for you to pay. No money has moved yet.",
            });
          }
          if (a.kind === "recipient") {
            const profile = await wise.resolveProfile(a.profileId);
            const r = await wise.createRecipient(profile, a);
            await log("recipient_created", { code: confirmation_code, summary: p.summary, recipient_id: r.id });
            return ok({ status: "recipient_created", recipient: r, summary: p.summary });
          }
          const t = await wise.cancelTransfer(a.transferId);
          await log("transfer_cancelled", { code: confirmation_code, summary: p.summary, status: t.status });
          return ok({ status: "cancelled", transfer_id: a.transferId, wise_status: t.status, summary: p.summary });
        } catch (err) {
          await log(`${a.kind}_failed`, { code: confirmation_code, summary: p.summary, error: String(err) });
          throw err;
        }
      }),
  );

  server.registerTool(
    "discard_action",
    {
      title: "Discard a prepared Wise action",
      description: "Throw away an action prepared with a prepare_* tool, before it's confirmed.",
      inputSchema: { confirmation_code: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ confirmation_code }) => {
      const removed = discardPending(sessionKey, confirmation_code);
      if (removed) await log("action_discarded", { code: confirmation_code });
      return ok(removed ? "Discarded. Nothing was sent to Wise." : "No pending action with that code.");
    },
  );
}

const stripHtml = (s: string) => s.replace(/<[^>]*>/g, "").trim();
