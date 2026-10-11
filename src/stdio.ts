import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { config } from "./config.js";
import { PUBLIC_DIR, VERSION, WEBSITE } from "./meta.js";
import { registerTools } from "./tools.js";
import { WiseAccessRevokedError, WiseApiError, WiseClient } from "./wise/client.js";
import { WiseService } from "./wise/service.js";

/**
 * Local mode: speaks MCP over stdin/stdout for Claude Desktop, Claude Code, Cursor, etc.
 * No OAuth or sessions: the Wise token comes from WISE_API_TOKEN in the app's MCP config.
 * stdout carries the protocol, so everything else goes to stderr.
 */
const log = (msg: string) => process.stderr.write(`[wise-mcp] ${msg}\n`);

const token = process.env.WISE_API_TOKEN?.trim();
if (!token) {
  log("WISE_API_TOKEN is not set. Create a token in Wise → Settings → API tokens and add it to this server's env.");
  process.exit(1);
}

const client = new WiseClient(token, config.WISE_API_URL);
try {
  const me = await client.me();
  log(`connected as Wise user ${me.id}`);
} catch (err) {
  if (err instanceof WiseAccessRevokedError || (err instanceof WiseApiError && err.status === 403)) {
    log("Wise rejected WISE_API_TOKEN. Check it's copied fully and not revoked.");
    process.exit(1);
  }
  log(`couldn't reach Wise yet (${err instanceof Error ? err.message : err}); tools will retry`);
}

mkdirSync(config.DATA_DIR, { recursive: true });

let icons: { src: string; mimeType: string; sizes: string[] }[] = [];
try {
  icons = [{ src: `data:image/svg+xml;base64,${readFileSync(path.join(PUBLIC_DIR, "logo.svg")).toString("base64")}`, mimeType: "image/svg+xml", sizes: ["any"] }];
} catch {
  /* icon is optional */
}

const server = new McpServer({ name: "wise", title: "Wise", version: VERSION, websiteUrl: WEBSITE, icons });
registerTools(server, new WiseService(client), {
  sessionKey: "local",
  connectionId: "local",
  onRevoked: async () => {
    log("Wise rejected the token (revoked or expired). Update WISE_API_TOKEN and restart.");
  },
});
await server.connect(new StdioServerTransport());
log(`ready (v${VERSION}, writes ${config.WRITES_ENABLED ? "enabled, two-step" : "disabled"}, audit log ${path.join(config.DATA_DIR, "audit.log")})`);
