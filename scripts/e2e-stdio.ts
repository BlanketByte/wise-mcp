/**
 * End-to-end test of local (stdio) mode: spawns the CLI like Claude Desktop / Claude Code would,
 * against a small local mock of the Wise API.
 *   npm run e2e:stdio
 */
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const MOCK_PORT = 3967;
const M = `http://localhost:${MOCK_PORT}`;
const DATA = path.resolve("./data-e2e-stdio");
const TOKEN = randomUUID();
const revoked = new Set<string>();
const created: any[] = [];
const quotes = new Map<string, any>();
const check = (label: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "✅" : "❌"} ${label}${extra ? "  " + extra : ""}`);
  if (!cond) process.exitCode = 1;
};

// --- Mock Wise -------------------------------------------------------------------
const mock = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : undefined;
  const p = new URL(req.url!, M).pathname;
  const send = (status: number, json: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(json));
  };
  const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
  if (token !== TOKEN || revoked.has(token)) return send(401, { error: "invalid_token" });
  if (p === "/v1/me") return send(200, { id: 101, name: "Local User" });
  if (p === "/v2/profiles") return send(200, [{ id: 1001, type: "PERSONAL", fullName: "Local User" }]);
  if (p === "/v4/profiles/1001/balances") {
    return send(200, new URL(req.url!, M).searchParams.get("types") === "SAVINGS" ? [] : [{ id: 1, type: "STANDARD", currency: "EUR", amount: { value: 120.5 }, reservedAmount: { value: 0 }, totalWorth: { value: 120.5 } }]);
  }
  if (p === "/v1/profiles/1001/activities") {
    return send(200, { cursor: null, activities: [{ id: "a1", type: "CARD_PAYMENT", status: "COMPLETED", title: "<strong>Coop</strong>", primaryAmount: "24.73 EUR", createdOn: "2026-10-11T10:00:00Z", resource: { type: "CARD_TRANSACTION", id: "1" } }] });
  }
  if (p === "/v2/accounts/501") return send(200, { id: 501, profileId: 1001, name: { fullName: "Mario Rossi" }, currency: "EUR", type: "iban", accountSummary: "IT60 X054", active: true });
  if (p === "/v3/profiles/1001/quotes" && req.method === "POST") {
    const q = { id: randomUUID(), sourceCurrency: body.sourceCurrency, targetCurrency: body.targetCurrency, sourceAmount: body.sourceAmount, targetAmount: body.sourceAmount, rate: 1, payOut: "BANK_TRANSFER", paymentOptions: [{ payIn: "BALANCE", payOut: "BANK_TRANSFER", disabled: false, fee: { total: 0 }, sourceAmount: body.sourceAmount, targetAmount: body.sourceAmount }] };
    quotes.set(q.id, q);
    return send(200, q);
  }
  if (p === "/v1/transfer-requirements") return send(200, []);
  if (p === "/v1/transfers" && req.method === "POST") {
    const q = quotes.get(body.quoteUuid);
    const t = { id: 9000 + created.length, status: "incoming_payment_waiting", ...body, sourceCurrency: q?.sourceCurrency, sourceValue: q?.sourceAmount, targetCurrency: q?.targetCurrency, targetValue: q?.targetAmount };
    created.push(t);
    return send(200, t);
  }
  send(404, { errors: [{ message: "not mocked: " + p }] });
});
await new Promise<void>((r) => mock.listen(MOCK_PORT, r));
rmSync(DATA, { recursive: true, force: true });

const tsx = path.resolve("node_modules/tsx/dist/cli.mjs");
const cli = path.resolve("src/cli.ts");
const baseEnv = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", WISE_API_URL: M, DATA_DIR: DATA };
/** Runs the CLI to completion without blocking the in-process mock (so no spawnSync here). */
const run = (env: Record<string, string>, args: string[] = []) =>
  new Promise<{ status: number | null; stderr: string; stdout: string }>((resolve) => {
    const child = spawn(process.execPath, [tsx, cli, ...args], { env: { ...baseEnv, ...env } });
    let stderr = "";
    let stdout = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.stdout.on("data", (d) => (stdout += d));
    child.stdin.end();
    child.on("close", (status) => resolve({ status, stderr, stdout }));
  });

// --- CLI basics --------------------------------------------------------------------
const help = spawnSync(process.execPath, [tsx, cli, "--help"], { encoding: "utf8" });
check("--help prints usage", help.status === 0 && help.stdout.includes("wise-mcp serve"));

const bad = await run({ WISE_API_TOKEN: randomUUID() });
check("rejected token exits with a clear message", bad.status === 1 && bad.stderr.includes("Wise rejected WISE_API_TOKEN"));

// --- MCP over stdio -------------------------------------------------------------------
async function connect(extraEnv: Record<string, string> = {}) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [tsx, cli], env: { ...baseEnv, WISE_API_TOKEN: TOKEN, ...extraEnv }, stderr: "pipe" });
  const client = new Client({ name: "e2e", version: "1" });
  await client.connect(transport);
  return client;
}
const text = (r: any) => r.content?.[0]?.text ?? "";

const client = await connect();
const info = client.getServerVersion();
check("serverInfo: title + embedded icon", info?.title === "Wise" && String(info?.icons?.[0]?.src).startsWith("data:image/svg+xml;base64,"));
const tools = (await client.listTools()).tools.map((t) => t.name);
check("all 14 tools available", tools.length === 14 && tools.includes("prepare_transfer") && tools.includes("confirm_action"), tools.length + " tools");
const bal = await client.callTool({ name: "list_balances", arguments: {} });
check("list_balances", !bal.isError && JSON.parse(text(bal)).balances[0].amount === 120.5 && (bal.structuredContent as any)?.balances?.[0]?.amount === 120.5);
const tx = await client.callTool({ name: "get_transactions", arguments: { limit: 5 } });
check("get_transactions", !tx.isError && JSON.parse(text(tx)).transactions[0].title === "Coop");
const prep = await client.callTool({ name: "prepare_transfer", arguments: { recipient_id: 501, send_amount: 10, reference: "pizza" } });
const code = JSON.parse(text(prep)).confirmation_code;
check("prepare_transfer: code, nothing created", !prep.isError && /^TX-/.test(code) && created.length === 0);
const conf = await client.callTool({ name: "confirm_action", arguments: { confirmation_code: code } });
check("confirm_action creates the unpaid transfer", !conf.isError && created.length === 1 && created[0].details.reference === "pizza");
check("audit log in DATA_DIR", existsSync(path.join(DATA, "audit.log")) && readFileSync(path.join(DATA, "audit.log"), "utf8").includes("transfer_created"));
revoked.add(TOKEN);
const after = await client.callTool({ name: "list_balances", arguments: {} });
check("revoked token → clear error", !!after.isError && text(after).includes("WISE_API_TOKEN"), text(after).slice(0, 80));
revoked.delete(TOKEN);
await client.close();

// Without a token the server still starts (directories inspect it this way); calls explain what to set.
const noTokenTransport = new StdioClientTransport({ command: process.execPath, args: [tsx, cli], env: { ...baseEnv }, stderr: "pipe" });
const noToken = new Client({ name: "e2e", version: "1" });
await noToken.connect(noTokenTransport);
check("no token: server starts and lists all 14 tools", (await noToken.listTools()).tools.length === 14);
const noTokenCall = await noToken.callTool({ name: "list_balances", arguments: {} });
check("no token: calls explain how to set WISE_API_TOKEN", !!noTokenCall.isError && text(noTokenCall).includes("WISE_API_TOKEN is not set"));
await noToken.close();

const ro = await connect({ WRITES_ENABLED: "false" });
const roTools = (await ro.listTools()).tools.map((t) => t.name);
check("WRITES_ENABLED=false → 7 read tools", roTools.length === 7 && !roTools.includes("confirm_action"));
await ro.close();

console.log(process.exitCode ? "\nSome checks failed" : "\nAll checks passed 🎉");
rmSync(DATA, { recursive: true, force: true });
mock.close();
process.exit();
