import { z } from "zod";

/**
 * Output schemas: the shape of each tool's structuredContent. They're loose on purpose (extra keys allowed, values
 * that come from Wise may be missing), so a new field in Wise's API can never make a tool call fail validation.
 */
const id = z.union([z.number(), z.string()]);
const num = z.number().nullish();
const str = z.string().nullish();
const money = z.looseObject({ amount: num, currency: str });
const profileRef = z.looseObject({ id, type: z.string() });
const profile = z.looseObject({ id, type: z.string(), name: str });

const recipient = z.looseObject({
  id,
  name: str,
  currency: str,
  type: str,
  account: str.describe("Account number or IBAN, as Wise shows it"),
  details: str,
  owned_by_me: z.boolean().nullish(),
  profile_id: id.nullish(),
  active: z.boolean().nullish(),
  profile: profileRef.optional(),
});

const transferShape = {
  id,
  created: str,
  status: str.describe("Wise transfer status, e.g. incoming_payment_waiting, outgoing_payment_sent, cancelled"),
  reference: str,
  source: money.describe("Amount converted, in the source currency (excludes the fee)"),
  target: money.describe("Amount the recipient gets"),
  recipient_id: id.nullish(),
};

const quote = z.looseObject({
  id: z.string(),
  source: money.describe("What you pay"),
  target: money.describe("What the recipient gets, when paid from the Wise balance"),
  rate: num,
  rate_type: str,
  rate_expires: str,
  fee: money.optional(),
  pay_in: str,
  pay_out: str,
  estimated_delivery: str,
  delivery: str,
  notices: z.array(z.string()).optional(),
  pay_in_options: z
    .array(z.looseObject({ pay_in: z.string(), fee: num, target_amount: num }))
    .optional()
    .describe("Price per payment method, cheapest first (methods with the same price merged)"),
});

const pending = {
  status: z.string().describe("awaiting_user_confirmation"),
  summary: z.string().describe("Show this to the user before confirming"),
  confirmation_code: z.string(),
  expires_at: z.string(),
};

export const outputs = {
  list_profiles: { profiles: z.array(profile) },

  list_balances: {
    balances: z.array(
      z.looseObject({
        id,
        profile: profileRef,
        kind: z.string().describe("balance or jar"),
        name: str,
        currency: str,
        amount: num.describe("Available to spend or send now; reserved money is already taken out of it"),
        reserved: num.describe(
          "Held for pending transactions (mostly card payments not settled yet). Already deducted from amount: not extra money",
        ),
        total_worth: num.describe("Only when it differs from amount, e.g. invested balances"),
        note: str,
      }),
    ),
  },

  get_transactions: {
    profile,
    count: z.number(),
    transactions: z.array(
      z.looseObject({
        id,
        date: str,
        type: str,
        status: str,
        title: str.describe("Merchant or counterparty"),
        description: str,
        direction: str.describe("in, out or neutral (between your own balances)"),
        amount: num,
        currency: str,
        amount_text: str,
        secondary_amount: money.optional(),
        secondary_text: str,
        resource: z.looseObject({ type: str, id: id.nullish() }).optional(),
      }),
    ),
    next_cursor: str,
  },

  list_transfers: {
    profile,
    total: z.number(),
    transfers: z.array(z.looseObject({ ...transferShape, recipient_name: str })),
    truncated: z.boolean().optional(),
  },

  get_transfer: {
    ...transferShape,
    recipient: recipient.optional(),
    rate: num,
    quote_id: str,
    has_active_issues: z.boolean().nullish(),
    raw_status: str,
    note: str,
  },

  list_recipients: { count: z.number(), recipients: z.array(recipient) },

  get_exchange_rate: { source: str, target: str, rate: num, time: str },

  get_quote: quote.shape,

  get_recipient_requirements: {
    options: z.array(
      z.looseObject({
        type: z.string().describe("Pass as `type` to prepare_recipient"),
        title: str,
        usage: str,
        fields: z.array(
          z.looseObject({
            key: z.string(),
            name: str,
            required: z.boolean(),
            type: str,
            example: str,
            pattern: str,
            allowed: z.array(z.looseObject({ key: id, name: str })).optional(),
            refresh_on_change: z.boolean().optional(),
          }),
        ),
      }),
    ),
  },

  prepare_recipient: pending,

  prepare_transfer: {
    ...pending,
    quote,
    balance_check: z.string(),
    next_step: z.string(),
  },

  prepare_cancel_transfer: pending,

  confirm_action: {
    status: z.string().describe("created_awaiting_payment, recipient_created or cancelled"),
    summary: z.string(),
    transfer_id: id.optional(),
    wise_status: str,
    recipient: recipient.optional(),
    wise_shows_until_paid: z.string().optional(),
    note: z.string().optional(),
    next_step: z.string().optional(),
  },

  discard_action: { status: z.string().describe("discarded or not_found"), message: z.string() },
};
