import type { Request, Response } from "express";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { InvalidClientMetadataError, InvalidGrantError, InvalidTargetError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { randomToken } from "../crypto.js";
import { ConnectionStore, wiseClient } from "../wise/connections.js";
import { WiseAccessRevokedError, WiseApiError, type WiseMe } from "../wise/client.js";
import { AuthStore } from "./store.js";
import { INSECURE_BANNER, loginPage, messagePage, pageCsp, SESSION_CHOICES } from "./pages.js";

const ACCESS_TTL_MS = 60 * 60 * 1000; // 1 hour
const DAY_MS = 24 * 60 * 60 * 1000;
const LOGIN_TTL_MS = 15 * 60 * 1000; // the login page must be submitted within 15 minutes
const CODE_TTL_MS = 2 * 60 * 1000; // our authorization code is valid for 2 minutes

interface PendingLogin {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  expiresAt: number;
}
interface IssuedCode {
  clientId: string;
  params: AuthorizationParams;
  sessionId: string;
  expiresAt: number;
}

export interface WiseAuthInfo extends AuthInfo {
  extra: { connectionId: string; sessionId: string };
}

export type IdentifyResult = { ok: true; me: WiseMe } | { ok: false; status: number; message: string };

/** Validates a pasted Wise token with GET /v1/me and checks the allowlist. Nothing is stored. */
export async function identify(token: string, allowedWiseUsers: number[]): Promise<IdentifyResult> {
  if (!/^[\w-]{16,200}$/.test(token)) return { ok: false, status: 400, message: "That doesn't look like a Wise API token." };
  let me: WiseMe;
  try {
    me = await wiseClient(token).me();
  } catch (err) {
    if (err instanceof WiseAccessRevokedError || (err instanceof WiseApiError && err.status === 403)) {
      return { ok: false, status: 401, message: "Wise rejected this token. Check it's copied fully and not revoked." };
    }
    console.error("Wise /v1/me failed", err instanceof Error ? err.message : err);
    return { ok: false, status: 502, message: "Couldn't reach Wise. Try again in a moment." };
  }
  if (typeof me?.id !== "number") return { ok: false, status: 502, message: "Unexpected answer from Wise." };
  if (!allowedWiseUsers.includes(me.id)) {
    console.warn(`Wise login refused for Wise user ${me.id}`);
    return {
      ok: false,
      status: 403,
      message: `This Wise account isn't allowed on this server. If it's yours, add <code>ALLOWED_WISE_USERS=${me.id}</code> to the server's environment and redeploy.`,
    };
  }
  return { ok: true, me };
}

/**
 * OAuth 2.1 authorization server for MCP clients (Claude, ChatGPT). Wise has no OAuth for individuals,
 * so login is a pasted Wise personal API token:
 *   client → /authorize → login page (token + session length) → POST /login → /v1/me + allowlist
 *   → token stored encrypted → code → the client exchanges it for access + rotating refresh tokens.
 */
export class WiseOAuthProvider implements OAuthServerProvider {
  private logins = new Map<string, PendingLogin>();
  private codes = new Map<string, IssuedCode>();

  constructor(
    private store: AuthStore,
    private connections: ConnectionStore,
    private resourceUrl: URL,
    private allowedRedirectHosts: string[],
    private allowedWiseUsers: number[],
  ) {}

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (id) => this.store.getClient(id),
      registerClient: (client) => {
        const full = client as OAuthClientInformationFull;
        for (const uri of full.redirect_uris) {
          const host = new URL(uri).hostname;
          if (!this.allowedRedirectHosts.some((h) => host === h || host.endsWith("." + h))) {
            throw new InvalidClientMetadataError(`redirect_uri host "${host}" is not allowed on this server`);
          }
        }
        this.store.saveClient(full);
        return full;
      },
    };
  }

  // --- Step 1: login page --------------------------------------------------
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response) {
    if (params.resource && !sameResource(params.resource, this.resourceUrl)) {
      throw new InvalidTargetError(`Unknown resource ${params.resource}`);
    }
    this.sweep();
    const loginId = randomToken();
    const pending = { client, params, expiresAt: Date.now() + LOGIN_TTL_MS };
    this.logins.set(loginId, pending);
    this.loginForm(res, loginId, pending);
  }

  // --- Step 2: POST /login (token + session length) ------------------------
  async handleLogin(req: Request, res: Response) {
    const loginId = String(req.body?.login_id ?? "");
    const pending = this.logins.get(loginId);
    if (!pending || pending.expiresAt < Date.now()) {
      this.logins.delete(loginId);
      page(res, 400).send(messagePage("Login expired", "Start connecting again from your app."));
      return;
    }
    const choice = SESSION_CHOICES.find((c) => c.value === String(req.body?.ttl ?? ""));
    if (!choice) return this.loginForm(res, loginId, pending, "Pick how long to stay connected.", 400);

    const token = String(req.body?.token ?? "").trim();
    const who = await identify(token, this.allowedWiseUsers);
    if (!who.ok) {
      if (who.status === 403) {
        this.logins.delete(loginId);
        page(res, 403).send(messagePage("Not allowed", who.message));
        return;
      }
      return this.loginForm(res, loginId, pending, who.message, who.status);
    }

    this.logins.delete(loginId); // single use
    const connectionId = this.connections.save(token, who.me);
    const now = Date.now();
    const sessionId = randomToken();
    this.store.createSession({
      id: sessionId,
      clientId: pending.client.client_id,
      clientName: pending.client.client_name,
      connectionId,
      createdAt: now,
      expiresAt: choice.days === null ? null : now + choice.days * DAY_MS,
      lastUsedAt: now,
    });
    console.log(`Wise login: user ${who.me.id}, session ${choice.days ?? "never"} days`);

    const code = randomToken();
    this.codes.set(code, { clientId: pending.client.client_id, params: pending.params, sessionId, expiresAt: now + CODE_TTL_MS });
    const target = new URL(pending.params.redirectUri);
    target.searchParams.set("code", code);
    if (pending.params.state !== undefined) target.searchParams.set("state", pending.params.state);
    res.redirect(302, target.toString());
  }

  private loginForm(res: Response, loginId: string, pending: PendingLogin, error?: string, status = 200) {
    // The form's POST answers with a redirect to the client's callback: allow that origin in form-action.
    page(res, status, [new URL(pending.params.redirectUri).origin]).send(
      loginPage({ loginId, clientName: pending.client.client_name, error }),
    );
  }

  // --- Step 3: token endpoint ----------------------------------------------
  async challengeForAuthorizationCode(_client: OAuthClientInformationFull, code: string) {
    const c = this.codes.get(code);
    if (!c || c.expiresAt < Date.now()) throw new InvalidGrantError("Invalid or expired authorization code");
    return c.params.codeChallenge;
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<OAuthTokens> {
    const c = this.codes.get(code);
    this.codes.delete(code); // single use
    if (!c || c.expiresAt < Date.now()) throw new InvalidGrantError("Invalid or expired authorization code");
    if (c.clientId !== client.client_id) throw new InvalidGrantError("Code was issued to another client");
    return this.issueTokens(c.sessionId, c.params.scopes ?? []);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string): Promise<OAuthTokens> {
    const found = this.store.getToken(refreshToken);
    if (!found || found.token.kind !== "refresh" || found.session.clientId !== client.client_id) {
      throw new InvalidGrantError("Invalid refresh token");
    }
    this.store.deleteToken(refreshToken); // rotation
    return this.issueTokens(found.session.id, found.token.scopes);
  }

  async verifyAccessToken(raw: string): Promise<WiseAuthInfo> {
    // InvalidTokenError → 401 + WWW-Authenticate, which makes Claude refresh or reconnect.
    const found = this.store.getToken(raw);
    if (!found || found.token.kind !== "access") throw new InvalidTokenError("Invalid or expired token");
    // Removing someone from ALLOWED_WISE_USERS (and redeploying) cuts off their existing sessions too.
    const conn = this.connections.get(found.session.connectionId);
    if (!conn || !this.allowedWiseUsers.includes(conn.wiseUserId)) {
      this.store.deleteSession(found.session.id);
      throw new InvalidTokenError("Session no longer allowed on this server");
    }
    this.store.touchSession(found.session.id);
    return {
      token: raw,
      clientId: found.session.clientId,
      scopes: found.token.scopes,
      expiresAt: Math.floor(found.token.expiresAt! / 1000),
      resource: new URL(found.token.resource),
      extra: { connectionId: found.session.connectionId, sessionId: found.session.id },
    };
  }

  async revokeToken(_client: OAuthClientInformationFull, request: { token: string }) {
    this.store.deleteToken(request.token);
  }

  private issueTokens(sessionId: string, scopes: string[]): OAuthTokens {
    const session = this.store.getSession(sessionId);
    if (!session) throw new InvalidGrantError("Session expired or revoked");
    const access = randomToken();
    const refresh = randomToken();
    const resource = this.resourceUrl.href;
    // Access tokens never outlive their session; refresh tokens live exactly as long as the session.
    const now = Date.now();
    const accessExpiresAt = Math.min(now + ACCESS_TTL_MS, session.expiresAt ?? Infinity);
    this.store.saveToken(access, { kind: "access", sessionId, scopes, expiresAt: accessExpiresAt, resource });
    this.store.saveToken(refresh, { kind: "refresh", sessionId, scopes, expiresAt: session.expiresAt, resource });
    return {
      access_token: access,
      token_type: "bearer",
      expires_in: Math.max(1, Math.floor((accessExpiresAt - now) / 1000)),
      refresh_token: refresh,
      scope: scopes.join(" "),
    };
  }

  private sweep() {
    const now = Date.now();
    for (const [k, v] of this.logins) if (v.expiresAt < now) this.logins.delete(k);
    for (const [k, v] of this.codes) if (v.expiresAt < now) this.codes.delete(k);
  }
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** True when the browser reached us over plain HTTP on a real hostname (behind the proxy, via X-Forwarded-Proto). */
export function isInsecure(req: Request) {
  return req.protocol !== "https" && !LOCAL_HOSTS.has(req.hostname);
}

export function page(res: Response, status = 200, formTargets: string[] = []) {
  if (isInsecure(res.req)) {
    // Put a red warning at the top of the card on every page that's served over HTTP.
    const send = res.send.bind(res);
    res.send = ((body?: unknown) =>
      send(typeof body === "string" ? body.replace('<div class="inner">', `<div class="inner">${INSECURE_BANNER}`) : body)) as typeof res.send;
  }
  res.status(status);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Security-Policy", pageCsp(formTargets));
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  return res.type("html");
}

function sameResource(a: URL, b: URL) {
  const norm = (u: URL) => u.href.replace(/#.*$/, "").replace(/\/$/, "");
  return norm(a) === norm(b);
}
