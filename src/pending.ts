import { randomBytes } from "node:crypto";

/**
 * Every write is a two-step flow:
 *   prepare_* -> validates, stores the action, returns a summary + one-time confirmation code
 *   confirm_action -> performs it in Wise (only with that exact code, from the same connection, within 10 minutes)
 * Nothing is written to Wise until confirm_action is called.
 */

export type PendingAction =
  | {
      kind: "transfer";
      profileId: number;
      quoteId: string;
      targetAccount: number;
      customerTransactionId: string;
      details: Record<string, unknown>;
      /** What the user approved: the transfer Wise creates must match it. */
      expected: { amount: number; currency: string };
    }
  | {
      kind: "recipient";
      profileId: number;
      currency: string;
      type: string;
      accountHolderName: string;
      ownedByCustomer?: boolean;
      details: Record<string, unknown>;
    }
  | { kind: "cancel_transfer"; transferId: number };

export interface Pending {
  owner: string; // session that prepared it (only it can confirm)
  action: PendingAction;
  summary: string;
  expiresAt: number;
}

const TTL_MS = 10 * 60 * 1000;
const PREFIX: Record<PendingAction["kind"], string> = { transfer: "TX", recipient: "RCP", cancel_transfer: "CXL" };
const pending = new Map<string, Pending>();

export function storePending(owner: string, action: PendingAction, summary: string): { code: string; expiresAt: Date } {
  sweep();
  const code = `${PREFIX[action.kind]}-${randomBytes(4).toString("hex").toUpperCase()}`;
  const expiresAt = Date.now() + TTL_MS;
  pending.set(code, { owner, action, summary, expiresAt });
  return { code, expiresAt: new Date(expiresAt) };
}

/** Returns and removes the pending action (one-time use). */
export function takePending(owner: string, code: string): Pending | undefined {
  sweep();
  const key = code.trim().toUpperCase();
  const p = pending.get(key);
  if (!p || p.owner !== owner) return undefined;
  pending.delete(key);
  return p;
}

export function discardPending(owner: string, code: string): boolean {
  const key = code.trim().toUpperCase();
  const p = pending.get(key);
  if (!p || p.owner !== owner) return false;
  return pending.delete(key);
}

function sweep() {
  const now = Date.now();
  for (const [k, v] of pending) if (v.expiresAt < now) pending.delete(k);
}
