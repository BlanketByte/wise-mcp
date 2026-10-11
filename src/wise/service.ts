import { WiseApiError, type WiseClient } from "./client.js";

export interface Profile {
  id: number;
  type: "PERSONAL" | "BUSINESS" | string;
  name?: string;
}

export interface ParsedAmount {
  amount: number;
  currency: string;
  direction: "in" | "out" | "neutral";
}

const PROFILE_TTL_MS = 5 * 60 * 1000;
/** Activity types that move money between the user's own balances. */
const NEUTRAL_TYPES = new Set(["INTERBALANCE", "AUTO_CONVERSION", "CARD_CHECK"]);
/** Friendly `type` filter names → Wise `monetaryResourceType`. */
export const ACTIVITY_TYPES: Record<string, string> = {
  card: "CARD_TRANSACTION",
  transfer: "TRANSFER",
  conversion: "BALANCE_TRANSACTION",
  direct_debit: "DIRECT_DEBIT_TRANSACTION",
  cashback: "BALANCE_CASHBACK",
  interest: "BALANCE_INTEREST",
};

export const stripTags = (s: string | undefined | null) =>
  (s ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

/** "1,234.56" / "1.234,56" / "2,000" / "24.73" → number */
export function parseNumber(raw: string): number {
  let s = raw.replace(/[\s  ']/g, "");
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma >= 0 && lastDot >= 0) {
    s = lastComma > lastDot ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  } else if (lastComma >= 0) {
    s = /^\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, "") : s.replace(",", ".");
  }
  return Number(s);
}

/**
 * Parses Wise's formatted activity amounts:
 *   "24.73 EUR" (out), "<positive>+ 4,500 EUR</positive>" (in), "<negative>- 5 EUR</negative>" (out).
 * Returns undefined for non-amount text such as "Roundup".
 */
export function parseAmount(text: string | undefined | null, activityType?: string): ParsedAmount | undefined {
  if (!text) return undefined;
  const plain = stripTags(text);
  const m = plain.match(/([+\-−])?\s*([\d][\d.,\s  ']*)\s*([A-Z]{3})\b/);
  if (!m) return undefined;
  const amount = parseNumber(m[2]);
  if (!Number.isFinite(amount)) return undefined;
  let direction: ParsedAmount["direction"];
  if (/<positive>/i.test(text) || m[1] === "+") direction = "in";
  else if (/<negative>/i.test(text) || m[1] === "-" || m[1] === "−") direction = "out";
  else direction = activityType && NEUTRAL_TYPES.has(activityType) ? "neutral" : "out";
  return { amount, currency: m[3], direction };
}

function profileName(p: any): string | undefined {
  return (
    p.fullName ??
    p.businessName ??
    p.details?.name ??
    ([p.firstName ?? p.details?.firstName, p.lastName ?? p.details?.lastName].filter(Boolean).join(" ") || undefined)
  );
}

/** Wise accepts ISO 8601; plain dates are expanded to the whole UTC day. */
function isoBound(date: string | undefined, end: boolean): string | undefined {
  if (!date) return undefined;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T${end ? "23:59:59.999" : "00:00:00.000"}Z` : date);
  if (Number.isNaN(d.getTime())) throw new Error(`"${date}" isn't a valid date. Use YYYY-MM-DD or an ISO 8601 timestamp.`);
  return d.toISOString();
}

export class WiseService {
  private profiles?: { at: number; list: Profile[] };

  constructor(readonly client: WiseClient) {}

  // --- Profiles ---------------------------------------------------------------
  async listProfiles(): Promise<Profile[]> {
    if (this.profiles && Date.now() - this.profiles.at < PROFILE_TTL_MS) return this.profiles.list;
    const raw = await this.client.get<any[]>("/v2/profiles");
    const list = raw.map((p) => ({ id: p.id, type: String(p.type ?? "UNKNOWN"), name: profileName(p) }));
    this.profiles = { at: Date.now(), list };
    return list;
  }

  /** Accepts a profile id, "personal", "business" or (part of) a profile name. Default: the personal profile. */
  async resolveProfile(ref?: string | number): Promise<Profile> {
    const profiles = await this.listProfiles();
    if (!profiles.length) throw new Error("This Wise user has no profiles.");
    if (ref === undefined || ref === "") return profiles.find((p) => p.type === "PERSONAL") ?? profiles[0];
    const s = String(ref).trim().toLowerCase();
    const found =
      profiles.find((p) => String(p.id) === s) ??
      profiles.find((p) => p.type.toLowerCase() === s) ??
      profiles.find((p) => p.name?.toLowerCase().includes(s));
    if (!found) {
      throw new Error(`Unknown profile "${ref}". Available: ${profiles.map((p) => `${p.id} (${p.type}${p.name ? ", " + p.name : ""})`).join("; ")}`);
    }
    return found;
  }

  /** One profile, or all of them when `ref` is omitted or "all". */
  async resolveProfiles(ref?: string | number): Promise<Profile[]> {
    if (ref === undefined || ref === "" || String(ref).toLowerCase() === "all") return this.listProfiles();
    return [await this.resolveProfile(ref)];
  }

  // --- Balances ---------------------------------------------------------------
  async listBalances(profiles: Profile[], includeEmpty: boolean) {
    const perProfile = await Promise.all(
      profiles.map(async (p) => {
        const [standard, savings] = await Promise.all(
          ["STANDARD", "SAVINGS"].map((types) => this.client.get<any[]>(`/v4/profiles/${p.id}/balances`, { types })),
        );
        return [...standard, ...savings].map((b) => ({
          id: b.id,
          profile: { id: p.id, type: p.type },
          kind: b.type === "SAVINGS" ? "jar" : "balance",
          name: b.name ?? undefined,
          currency: b.currency,
          amount: b.amount?.value,
          reserved: b.reservedAmount?.value || undefined,
          total_worth: b.totalWorth?.value !== b.amount?.value ? b.totalWorth?.value : undefined,
        }));
      }),
    );
    return perProfile.flat().filter((b) => includeEmpty || Number(b.amount) !== 0 || Number(b.reserved ?? 0) !== 0);
  }

  // --- Activities (transactions, incl. card payments) ---------------------------
  async listActivities(opts: {
    profile: Profile;
    limit: number;
    since?: string;
    until?: string;
    resourceType?: string;
    status?: string;
    search?: string;
    cursor?: string;
  }) {
    const search = opts.search?.trim().toLowerCase();
    const maxPages = search ? 20 : Math.ceil(opts.limit / 100) + 1;
    const out: ReturnType<typeof mapActivity>[] = [];
    let cursor = opts.cursor;
    let pages = 0;
    do {
      // Without a search, page sizes line up with `limit` so Wise's cursor resumes exactly after the last item returned.
      // With a search we keep whole pages (all matches), so a page can push the count slightly over `limit`.
      const size = search ? 100 : Math.min(100, opts.limit - out.length);
      const res = await this.client.get<any>(`/v1/profiles/${opts.profile.id}/activities`, {
        size,
        since: isoBound(opts.since, false),
        until: isoBound(opts.until, true),
        monetaryResourceType: opts.resourceType,
        status: opts.status,
        nextCursor: cursor,
      });
      const items = (res.activities ?? []).map(mapActivity);
      out.push(...(search ? items.filter((a: ReturnType<typeof mapActivity>) => matches(a, search)) : items));
      cursor = res.cursor ?? undefined;
      pages++;
    } while (cursor && out.length < opts.limit && pages < maxPages);
    return { activities: out, nextCursor: cursor, scannedPages: pages };
  }

  // --- Transfers ----------------------------------------------------------------
  async listTransfers(opts: { profile: Profile; limit: number; since?: string; until?: string; status?: string; search?: string }) {
    // Wise returns transfers oldest-first; fetch everything in range, then sort newest-first.
    const PAGE = 100;
    const MAX_PAGES = 20;
    const all: any[] = [];
    let offset = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const batch = await this.client.get<any[]>("/v1/transfers", {
        profile: opts.profile.id,
        limit: PAGE,
        offset,
        status: opts.status,
        createdDateStart: isoBound(opts.since, false),
        createdDateEnd: isoBound(opts.until, true),
      });
      all.push(...batch);
      if (batch.length < PAGE) break;
      offset += PAGE;
    }
    const names = new Map<number, string | undefined>();
    if (all.length) {
      const recipients = await this.listRecipients([opts.profile]).catch(() => []);
      for (const r of recipients) names.set(r.id, r.name);
    }
    const search = opts.search?.trim().toLowerCase();
    const transfers = all
      .map((t) => ({ ...mapTransfer(t), recipient_name: names.get(t.targetAccount) }))
      .filter((t) => !search || JSON.stringify([t.reference, t.recipient_name, t.id]).toLowerCase().includes(search))
      .sort((a, b) => String(b.created).localeCompare(String(a.created)));
    return { total: transfers.length, transfers: transfers.slice(0, opts.limit), truncated: all.length >= PAGE * MAX_PAGES };
  }

  async getTransfer(id: number) {
    const t = await this.client.get<any>(`/v1/transfers/${id}`);
    const recipient = t.targetAccount ? await this.getRecipient(t.targetAccount).catch(() => undefined) : undefined;
    return {
      ...mapTransfer(t),
      recipient,
      rate: t.rate,
      quote_id: t.quoteUuid ?? t.quote,
      has_active_issues: t.hasActiveIssues,
      raw_status: t.status,
      note: t.status === "incoming_payment_waiting" ? UNPAID_PRICE_NOTE : undefined,
    };
  }

  // --- Recipients -----------------------------------------------------------------
  async listRecipients(profiles: Profile[], currency?: string) {
    const lists = await Promise.all(
      profiles.map(async (p) => {
        // Wise pages saved recipients with a seek position; follow it (capped) so long lists aren't cut at 100.
        const items: any[] = [];
        let seek: string | number | undefined;
        for (let page = 0; page < 10; page++) {
          const res = await this.client.get<any>("/v2/accounts", { profileId: p.id, size: 100, currency: currency?.toUpperCase(), seekPosition: seek });
          items.push(...(Array.isArray(res) ? res : (res.content ?? [])));
          seek = Array.isArray(res) ? undefined : (res.seekPositionForNext ?? undefined);
          if (seek === undefined || seek === null) break;
        }
        return items.map((r) => ({ ...mapRecipient(r), profile: { id: p.id, type: p.type } }));
      }),
    );
    return lists.flat();
  }

  async getRecipient(id: number) {
    return mapRecipient(await this.client.get<any>(`/v2/accounts/${id}`));
  }

  // --- Quotes, recipients and transfers (write) ------------------------------------
  /** Creates a Wise quote. Moves no money; a quote is the price a transfer would be made at. */
  async createQuote(
    profile: Profile,
    q: { sourceCurrency: string; targetCurrency: string; sourceAmount?: number; targetAmount?: number; targetAccount?: number },
  ) {
    const raw = await this.client.post<any>(`/v3/profiles/${profile.id}/quotes`, {
      sourceCurrency: q.sourceCurrency.toUpperCase(),
      targetCurrency: q.targetCurrency.toUpperCase(),
      sourceAmount: q.sourceAmount ?? null,
      targetAmount: q.targetAmount ?? null,
      targetAccount: q.targetAccount,
      // The user pays from their Wise balance in the app: list (and show) that price first.
      preferredPayIn: "BALANCE",
    });
    return mapQuote(raw);
  }

  /** Fields Wise needs to create a recipient in `target` currency (via a throwaway quote). */
  async recipientRequirements(profile: Profile, source: string, target: string, amount: number) {
    const quote = await this.createQuote(profile, { sourceCurrency: source, targetCurrency: target, sourceAmount: amount });
    const raw = await this.client.get<any[]>(`/v1/quotes/${quote.id}/account-requirements`, {}, { "Accept-Minor-Version": "1" });
    return raw.map((r) => ({
      type: r.type,
      title: r.title,
      usage: r.usageInfo ?? undefined,
      fields: (r.fields ?? []).flatMap((f: any) => (f.group ?? []).map(mapRequirementField)),
    }));
  }

  async createRecipient(
    profile: Profile,
    r: { currency: string; type: string; accountHolderName: string; ownedByCustomer?: boolean; details: Record<string, unknown> },
  ) {
    const raw = await this.client.post<any>("/v1/accounts", {
      profile: profile.id,
      currency: r.currency.toUpperCase(),
      type: r.type,
      accountHolderName: r.accountHolderName,
      ownedByCustomer: r.ownedByCustomer,
      details: r.details,
    });
    return mapRecipient(raw);
  }

  /** Extra fields Wise needs for this transfer (e.g. transferPurpose, sourceOfFunds) that weren't provided. */
  async missingTransferFields(quoteId: string, targetAccount: number, details: Record<string, unknown>) {
    const raw = await this.client.post<any[]>("/v1/transfer-requirements", { targetAccount, quoteUuid: quoteId, details });
    const fields = (raw ?? []).flatMap((r: any) => (r.fields ?? []).flatMap((f: any) => (f.group ?? []).map(mapRequirementField)));
    return fields
      .map((f: ReturnType<typeof mapRequirementField>) => ({ ...f, key: f.key.replace(/^details\./, "") }))
      .filter((f: ReturnType<typeof mapRequirementField>) => f.required && f.key !== "reference" && details[f.key] === undefined);
  }

  async createTransfer(t: { targetAccount: number; quoteId: string; customerTransactionId: string; details: Record<string, unknown> }) {
    // customerTransactionId makes this idempotent, so a retry after a timeout can't create a second transfer.
    const raw = await this.client.post<any>(
      "/v1/transfers",
      { targetAccount: t.targetAccount, quoteUuid: t.quoteId, customerTransactionId: t.customerTransactionId, details: t.details },
      { idempotent: true },
    );
    return mapTransfer(raw);
  }

  async cancelTransfer(id: number) {
    return mapTransfer(await this.client.put<any>(`/v1/transfers/${id}/cancel`));
  }

  // --- Rates ------------------------------------------------------------------------
  async getRate(source: string, target: string, at?: string) {
    const res = await this.client.get<any[]>("/v1/rates", { source: source.toUpperCase(), target: target.toUpperCase(), time: at ? isoBound(at, false) : undefined });
    const r = Array.isArray(res) ? res[0] : res;
    if (!r) throw new WiseApiError(404, `No rate for ${source}→${target}`);
    return { source: r.source, target: r.target, rate: r.rate, time: r.time };
  }
}

function mapActivity(a: any) {
  const amount = parseAmount(a.primaryAmount, a.type);
  const secondary = parseAmount(a.secondaryAmount);
  const secondaryText = stripTags(a.secondaryAmount);
  return {
    id: a.id,
    date: a.createdOn,
    type: a.type,
    status: a.status,
    title: stripTags(a.title),
    description: stripTags(a.description) || undefined,
    direction: amount?.direction,
    amount: amount?.amount,
    currency: amount?.currency,
    amount_text: amount ? undefined : stripTags(a.primaryAmount) || undefined,
    secondary_amount: secondary ? { amount: secondary.amount, currency: secondary.currency } : undefined,
    secondary_text: !secondary && secondaryText ? secondaryText : undefined,
    resource: a.resource?.type ? { type: a.resource.type, id: a.resource.id } : undefined,
  };
}

function matches(a: ReturnType<typeof mapActivity>, search: string) {
  return [a.title, a.description, a.type, a.secondary_text, a.amount_text].some((v) => v?.toLowerCase().includes(search));
}

/** Wise prices a transfer made via the API as a bank-transfer pay-in until it's paid (seen: 1 EUR → 0.05 EUR, fee 0.95). */
export const UNPAID_PRICE_NOTE =
  "Amounts of an unpaid transfer are Wise's bank-transfer price (with its fee). Paying it from the Wise balance in the app re-prices it, e.g. without that fee.";

function mapTransfer(t: any) {
  return {
    id: t.id,
    created: t.created,
    status: t.status,
    reference: t.reference || t.details?.reference || undefined,
    source: { amount: t.sourceValue, currency: t.sourceCurrency },
    target: { amount: t.targetValue, currency: t.targetCurrency },
    recipient_id: t.targetAccount ?? undefined,
  };
}

function mapRecipient(r: any) {
  return {
    id: r.id,
    name: typeof r.name === "string" ? r.name : (r.name?.fullName ?? r.accountHolderName),
    currency: r.currency,
    type: r.type,
    account: r.accountSummary ?? r.longAccountSummary ?? undefined,
    details: r.longAccountSummary && r.longAccountSummary !== r.accountSummary ? r.longAccountSummary : undefined,
    owned_by_me: r.ownedByCustomer ?? undefined,
    profile_id: r.profileId ?? r.profile ?? undefined,
    active: r.active ?? undefined,
  };
}

function mapQuote(q: any) {
  const options: any[] = (q.paymentOptions ?? []).filter((o: any) => !o.disabled && (!q.payOut || o.payOut === q.payOut));
  // The user pays in the Wise app, usually from the balance: show that price (createQuote lists BALANCE first).
  const o = options.find((x) => x.payIn === "BALANCE") ?? options[0];
  return {
    id: String(q.id),
    source: { amount: o?.sourceAmount ?? q.sourceAmount, currency: q.sourceCurrency },
    target: { amount: o?.targetAmount ?? q.targetAmount, currency: q.targetCurrency },
    rate: q.rate,
    rate_type: q.rateType,
    rate_expires: q.rateExpirationTime,
    fee: o?.fee?.total !== undefined ? { amount: o.fee.total, currency: q.sourceCurrency } : undefined,
    pay_in: o?.payIn,
    pay_out: o?.payOut ?? q.payOut,
    estimated_delivery: o?.estimatedDelivery,
    delivery: o?.formattedEstimatedDelivery,
    notices: (q.notices ?? []).map((n: any) => stripTags(n.text)).filter(Boolean),
    // Every way to pay in the app, cheapest first; methods with the same price are merged (~20 cards and wallets
    // collapse to a few lines). An unpaid transfer shows the BANK_TRANSFER price until it's paid.
    pay_in_options: groupPayIns(options),
  };
}

function groupPayIns(options: any[]) {
  const groups = new Map<string, { pay_in: string[]; fee: number; target_amount: number }>();
  for (const x of options) {
    const key = `${x.fee?.total}|${x.targetAmount}`;
    const g = groups.get(key) ?? { pay_in: [] as string[], fee: x.fee?.total, target_amount: x.targetAmount };
    g.pay_in.push(x.payIn);
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => a.fee - b.fee).map((g) => ({ ...g, pay_in: g.pay_in.join(", ") }));
}

function mapRequirementField(g: any) {
  return {
    key: String(g.key),
    name: g.name,
    required: !!g.required,
    type: g.type,
    example: g.example || undefined,
    pattern: g.validationRegexp || undefined,
    allowed: g.valuesAllowed?.length ? g.valuesAllowed.map((v: any) => ({ key: v.key, name: v.name })) : undefined,
    refresh_on_change: g.refreshRequirementsOnChange || undefined,
  };
}
