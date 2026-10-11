import path from "node:path";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { loadServerConfig } from "./config.js";
import { PUBLIC_DIR, VERSION } from "./meta.js";
import { SecretBox, sha256 } from "./crypto.js";
import { ConnectionStore } from "./wise/connections.js";
import { registerTools } from "./tools.js";
import { AuthStore } from "./auth/store.js";
import { WiseOAuthProvider, identify, page, type WiseAuthInfo } from "./auth/provider.js";
import { homePage, messagePage, sessionsLoginPage, sessionsPage } from "./auth/pages.js";

const config = loadServerConfig();
const publicUrl = new URL(config.PUBLIC_URL);
const mcpUrl = new URL("/mcp", publicUrl);
const iconUrl = new URL("/icon.png", publicUrl).href;
const iconSvgUrl = new URL("/logo.svg", publicUrl).href;

const box = new SecretBox(config.TOKEN_ENCRYPTION_KEY);
const connections = new ConnectionStore(config.DATA_DIR, box);
const store = new AuthStore(config.DATA_DIR);
const provider = new WiseOAuthProvider(store, connections, mcpUrl, config.allowedRedirectHosts, config.allowedWiseUsers);

/** Forget Wise tokens that no live session uses. */
const pruneConnections = () => connections.prune(new Set(store.listSessions().map((s) => s.connectionId)));
pruneConnections();
setInterval(pruneConnections, 60 * 60 * 1000).unref();

const app = express();
app.set("trust proxy", 1); // behind one reverse proxy (Traefik, Caddy, nginx…) that sets X-Forwarded-For
app.disable("x-powered-by");

// --- Icons and logo ------------------------------------------------------------
const asset = (file: string, type: string) => (req: express.Request, res: express.Response) => {
  // Pages link assets with ?v=<content hash>, so those can be cached for good; bare URLs only briefly.
  res.setHeader("Cache-Control", req.query.v ? "public, max-age=31536000, immutable" : "public, max-age=3600");
  res.type(type).sendFile(path.join(PUBLIC_DIR, file));
};
app.get(["/icon.png", "/favicon.png"], asset("icon.png", "image/png"));
app.get("/apple-touch-icon.png", asset("apple-touch-icon.png", "image/png"));
app.get("/favicon.ico", asset("favicon.ico", "image/x-icon"));
app.get("/logo.png", asset("logo.png", "image/png"));
app.get("/logo.svg", asset("logo.svg", "image/svg+xml"));
app.get("/", (_req, res) => page(res).send(homePage(mcpUrl.href)));

// --- OAuth for MCP clients, login = pasted Wise API token ---------------------
app.use(
  mcpAuthRouter({
    provider,
    issuerUrl: publicUrl,
    resourceServerUrl: mcpUrl,
    resourceName: "Wise",
    scopesSupported: ["wise"],
  }),
);
const form = express.urlencoded({ extended: false, limit: "8kb" });

/** Small per-IP limiter for the token forms, so they can't be used to hammer Wise from this server. */
function rateLimit(max: number, windowMs: number) {
  const hits = new Map<string, { n: number; reset: number }>();
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const now = Date.now();
    if (hits.size > 10_000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
    const key = req.ip ?? "unknown";
    let h = hits.get(key);
    if (!h || h.reset < now) hits.set(key, (h = { n: 0, reset: now + windowMs }));
    if (++h.n > max) {
      res.setHeader("Retry-After", String(Math.ceil((h.reset - now) / 1000)));
      page(res, 429).send(messagePage("Too many attempts", "Wait a few minutes, then try again."));
      return;
    }
    next();
  };
}
const LOGIN_LIMIT = { max: 20, windowMs: 15 * 60 * 1000 };

app.post("/login", rateLimit(LOGIN_LIMIT.max, LOGIN_LIMIT.windowMs), form, async (req, res) => {
  try {
    await provider.handleLogin(req, res);
  } catch (err) {
    console.error("login error", err);
    if (!res.headersSent) page(res, 500).send(messagePage("Login failed", "Something went wrong. Start connecting again from your app."));
  }
});

// --- /sessions: see and revoke connected sessions (sign in with a Wise token) ---
const ADMIN_COOKIE = "wise_mcp_admin";
const ADMIN_TTL_MS = 15 * 60 * 1000;

function adminUser(req: express.Request): number | undefined {
  const raw = (req.headers.cookie ?? "").split(/;\s*/).find((c) => c.startsWith(ADMIN_COOKIE + "="));
  const value = raw && box.unsign(decodeURIComponent(raw.slice(ADMIN_COOKIE.length + 1)));
  if (!value) return undefined;
  const [userId, exp] = value.split(":").map(Number);
  return exp > Date.now() && config.allowedWiseUsers.includes(userId) ? userId : undefined;
}

function sessionsFor(wiseUserId: number) {
  return store.listSessions().filter((s) => connections.get(s.connectionId)?.wiseUserId === wiseUserId);
}

app.get("/sessions", (req, res) => {
  const userId = adminUser(req);
  if (!userId) return page(res).send(sessionsLoginPage());
  const flash = req.query.revoked ? `Revoked ${Number(req.query.revoked) || 0} session(s).` : undefined;
  const sessions = sessionsFor(userId);
  const label = sessions.map((s) => connections.get(s.connectionId)?.wiseUserLabel).find(Boolean) ?? `Wise user ${userId}`;
  page(res).send(sessionsPage({ userName: label, sessions, flash }));
});

app.post("/sessions/login", rateLimit(LOGIN_LIMIT.max, LOGIN_LIMIT.windowMs), form, async (req, res) => {
  const who = await identify(String(req.body?.token ?? "").trim(), config.allowedWiseUsers);
  if (!who.ok) {
    if (who.status === 403) return page(res, 403).send(messagePage("Not allowed", who.message));
    return page(res, who.status).send(sessionsLoginPage(who.message));
  }
  const cookie = box.sign(`${who.me.id}:${Date.now() + ADMIN_TTL_MS}`);
  res.cookie(ADMIN_COOKIE, cookie, { httpOnly: true, secure: true, sameSite: "strict", maxAge: ADMIN_TTL_MS, path: "/sessions" });
  res.redirect(303, "/sessions");
});

app.post("/sessions/revoke", form, (req, res) => {
  const userId = adminUser(req);
  if (!userId) return page(res, 401).send(sessionsLoginPage("Session expired, sign in again."));
  const id = String(req.body?.id ?? "");
  const targets = sessionsFor(userId).filter((s) => id === "*" || s.id === id);
  for (const s of targets) store.deleteSession(s.id);
  pruneConnections();
  res.redirect(303, `/sessions?revoked=${targets.length}`);
});

// --- MCP (stateless Streamable HTTP) ----------------------------------------
const auth = requireBearerAuth({
  verifier: provider,
  resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
  expectedResource: mcpUrl,
});

app.post("/mcp", auth, express.json({ limit: "1mb" }), async (req, res) => {
  const { connectionId, sessionId } = (req.auth as WiseAuthInfo).extra;
  const wise = connections.service(connectionId);
  if (!wise) {
    store.deleteSessionsForConnection(connectionId);
    res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Wise connection missing, reconnect" }, id: null });
    return;
  }
  const server = new McpServer({
    name: "wise",
    title: "Wise",
    version: VERSION,
    websiteUrl: config.PUBLIC_URL,
    icons: [
      { src: iconUrl, mimeType: "image/png", sizes: ["256x256"] },
      { src: iconSvgUrl, mimeType: "image/svg+xml", sizes: ["any"] },
    ],
  });
  registerTools(server, wise, {
    sessionKey: sessionId,
    connectionId,
    onRevoked: async () => {
      console.warn(`Wise token rejected for connection ${connectionId}; removing it and its sessions`);
      store.deleteSessionsForConnection(connectionId);
      connections.remove(connectionId);
    },
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP error", err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
});

const methodNotAllowed = (_req: express.Request, res: express.Response) => {
  res.status(405).set("Allow", "POST").json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed (stateless server)" },
    id: null,
  });
};
app.get("/mcp", auth, methodNotAllowed);
app.delete("/mcp", auth, methodNotAllowed);

app.get("/health", (_req, res) => {
  res.json({ ok: true, version: VERSION });
});

app.listen(config.PORT, () => {
  console.log(`✅ Wise MCP listening on :${config.PORT}`);
  console.log(`   MCP endpoint:    ${mcpUrl.href}`);
  console.log(`   Wise API:        ${config.WISE_API_URL}`);
  console.log(`   allowed users:   ${config.allowedWiseUsers.join(", ") || "none (set ALLOWED_WISE_USERS)"}`);
  console.log(`   encryption key:  sha256 ${sha256(config.TOKEN_ENCRYPTION_KEY).slice(0, 8)}`);
  console.log(`   active sessions: ${store.listSessions().length}`);
  console.log(`   writes:          ${config.WRITES_ENABLED ? `two-step, transfers paid in the Wise app${config.MAX_TRANSFER_AMOUNT ? ` (max ${config.MAX_TRANSFER_AMOUNT})` : ""}` : "disabled (read-only)"}`);
});
