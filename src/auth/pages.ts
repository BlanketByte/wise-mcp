import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { PUBLIC_DIR, REPO_URL, WEBSITE } from "../meta.js";
import type { Session } from "./store.js";

/** Asset URL with a content hash, so browsers never show a stale logo after a deploy. */
const asset = (file: string) => {
  try {
    return `/${file}?v=${createHash("sha256").update(readFileSync(path.join(PUBLIC_DIR, file))).digest("hex").slice(0, 10)}`;
  } catch {
    return `/${file}`;
  }
};
const A = {
  ico: asset("favicon.ico"),
  svg: asset("logo.svg"),
  png: asset("logo.png"),
  touch: asset("apple-touch-icon.png"),
};

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export const SESSION_CHOICES = [
  { value: "5", label: "5 days", days: 5 },
  { value: "15", label: "15 days", days: 15 },
  { value: "30", label: "30 days", days: 30 },
  { value: "90", label: "90 days", days: 90 },
  { value: "never", label: "Always", days: null },
] as const;
export const DEFAULT_SESSION_CHOICE = "30";

/**
 * form-action also covers redirects after a submit: POST /login redirects to Claude's callback,
 * so the login page passes that origin in `formTargets`.
 */
export function pageCsp(formTargets: string[] = []) {
  return (
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; " +
    `form-action ${["'self'", ...formTargets].join(" ")}; frame-ancestors 'none'; base-uri 'none'`
  );
}

/** Small inline line icons (24×24, stroke = currentColor). */
const ICONS: Record<string, string> = {
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  arrows: '<path d="M4 8h14M14 4l4 4-4 4M20 16H6M10 12l-4 4 4 4"/>',
  hand: '<path d="M12 3v18M17 7.5C17 5.6 14.8 4.5 12 4.5S7 5.6 7 7.5s2 2.7 5 3.5 5 1.6 5 3.5-2.2 3-5 3-5-1.1-5-3"/>',
  shield: '<path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.3 7.5 9.5 4.3-1.2 7.5-4.9 7.5-9.5V6L12 3Z"/><path d="m9 12 2 2 4-4"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m10.8 12.2 9.2-9.2M17 6l3 3M14.5 8.5l2 2"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2.5"/><path d="M8 11V7.5a4 4 0 0 1 8 0V11"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5h.01"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  github:
    '<path d="M9 19c-4.3 1.4 -4.3 -2.5 -6 -3m12 5v-3.5c0 -1 .1 -1.4 -.5 -2c2.8 -.3 5.5 -1.4 5.5 -6a4.6 4.6 0 0 0 -1.3 -3.2a4.2 4.2 0 0 0 -.1 -3.2s-1.1 -.3 -3.5 1.3a12.3 12.3 0 0 0 -6.2 0c-2.4 -1.6 -3.5 -1.3 -3.5 -1.3a4.2 4.2 0 0 0 -.1 3.2a4.6 4.6 0 0 0 -1.3 3.2c0 4.6 2.7 5.7 5.5 6c-.6 .6 -.6 1.2 -.5 2v3.5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  logout: '<path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4M10 16l-4-4 4-4M6 12h10"/>',
};
const icon = (name: string, cls = "") =>
  `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

function layout(title: string, body: string) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${esc(title)}</title>
<link rel="icon" href="${A.ico}" sizes="any">
<link rel="icon" type="image/svg+xml" href="${A.svg}">
<link rel="apple-touch-icon" href="${A.touch}">
<style>
  :root {
    --bg:#eef4f6; --card:#ffffff; --fg:#0f1d22; --muted:#5d6b71; --faint:#8b989d; --line:#dfe7ea; --soft:#f2f6f7;
    --teal:#1a4d5c; --teal-2:#5ba3b8; --lime:#9fe870; --forest:#163300;
    --btn:#9fe870; --btn-fg:#163300; --btn-hover:#80e142; --focus:#5ba3b8;
    --err:#b42318; --err-bg:#fef3f2; --ok:#067647; --ok-bg:#ecfdf3;
    --glow-1:rgba(91,163,184,.28); --glow-2:rgba(159,232,112,.22);
    --warn:#b54708; --warn-bg:#fff4e5; --warn-line:#fedf89;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg:#091214; --card:#111c20; --fg:#eef4f5; --muted:#9db0b6; --faint:#6f8287; --line:#21323a; --soft:#16252a;
      --btn:#9fe870; --btn-fg:#163300; --btn-hover:#80e142; --focus:#9fe870;
      --err:#ff9b8f; --err-bg:#2a1513; --ok:#7ee2a8; --ok-bg:#0f2a1c;
      --glow-1:rgba(91,163,184,.18); --glow-2:rgba(159,232,112,.10);
      --warn:#fdb022; --warn-bg:#2b1d0b; --warn-line:#5a3a10;
    }
  }
  * { box-sizing:border-box; }
  html { -webkit-text-size-adjust:100%; }
  body {
    margin:0; min-height:100vh; display:grid; place-items:center; padding:24px 16px; color:var(--fg);
    font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",sans-serif;
    background:
      radial-gradient(900px 520px at 12% -10%, var(--glow-1), transparent 60%),
      radial-gradient(760px 480px at 105% 110%, var(--glow-2), transparent 60%),
      var(--bg);
    -webkit-font-smoothing:antialiased;
  }
  main {
    width:100%; max-width:440px; background:var(--card); border:1px solid var(--line); border-radius:28px;
    box-shadow:0 1px 2px rgba(15,29,34,.04), 0 24px 64px -28px rgba(15,29,34,.28);
  }
  main.wide { max-width:720px; }
  .inner { padding:32px; }
  @media (max-width:480px) { .inner { padding:24px 20px; } main { border-radius:22px; } }
  .hero { text-align:center; margin-bottom:24px; }
  .hero img { width:76px; height:76px; border-radius:22px; display:block; margin:0 auto 16px;
              box-shadow:0 0 0 6px var(--soft), 0 10px 24px -12px rgba(26,77,92,.5); }
  h1 { font-size:22px; line-height:1.25; letter-spacing:-.01em; margin:0 0 6px; font-weight:650; }
  .sub { color:var(--muted); font-size:13.5px; margin:0; }
  .sub b, .sub a.brand { color:var(--fg); font-weight:600; text-decoration:none; }
  .sub a.brand:hover { text-decoration:underline; }
  .insecure { display:flex; gap:12px; align-items:flex-start; margin:0 0 24px; padding:14px 16px; border-radius:16px;
              background:#b42318; color:#fff; font-size:14px; line-height:1.5; box-shadow:0 0 0 4px rgba(180,35,24,.18); }
  .insecure .ic { width:22px; height:22px; flex:none; margin-top:1px; }
  .insecure strong { display:block; font-size:15px; }
  .notice { display:inline-flex; align-items:center; gap:6px; margin-top:10px; padding:5px 12px 5px 10px; border-radius:999px;
            background:var(--warn-bg); color:var(--warn); border:1px solid var(--warn-line); font-size:12.5px; font-weight:600; }
  .notice .ic { width:15px; height:15px; }
  p { margin:0 0 16px; }
  .muted { color:var(--muted); }
  .perms { list-style:none; margin:0 0 24px; padding:4px; background:var(--soft); border-radius:18px; }
  .perms li { display:flex; gap:12px; align-items:flex-start; padding:10px 12px; font-size:14px; }
  .perms li + li { border-top:1px solid var(--line); }
  .chip { flex:none; width:30px; height:30px; border-radius:10px; display:grid; place-items:center; background:var(--card); color:var(--teal-2);
          border:1px solid var(--line); }
  .perms strong { display:block; font-weight:600; }
  .perms span { color:var(--muted); font-size:13px; }
  .ic { width:18px; height:18px; flex:none; }
  .alert { display:flex; gap:10px; align-items:flex-start; padding:12px 14px; border-radius:14px; font-size:14px; margin-bottom:18px; }
  .alert.err { background:var(--err-bg); color:var(--err); }
  .alert.ok { background:var(--ok-bg); color:var(--ok); }
  .alert .ic { margin-top:1px; }
  .field { margin-bottom:20px; }
  .lbl { display:block; font-size:13.5px; font-weight:600; margin-bottom:8px; }
  .input { position:relative; }
  .input .ic { position:absolute; left:14px; top:50%; transform:translateY(-50%); color:var(--faint); pointer-events:none; }
  input[type=password] {
    width:100%; height:48px; padding:0 14px 0 42px; border-radius:14px; border:1px solid var(--line); background:var(--card); color:inherit;
    font:15px ui-monospace,SFMono-Regular,Menlo,monospace; letter-spacing:.02em; transition:border-color .15s, box-shadow .15s;
  }
  input[type=password]::placeholder { color:var(--faint); letter-spacing:0; }
  input[type=password]:focus { outline:none; border-color:var(--focus); box-shadow:0 0 0 4px color-mix(in srgb, var(--focus) 22%, transparent); }
  details { margin-top:10px; font-size:13px; color:var(--muted); }
  summary { cursor:pointer; color:var(--teal-2); font-weight:550; list-style:none; display:inline-flex; align-items:center; gap:6px; }
  summary::-webkit-details-marker { display:none; }
  summary::after { content:"›"; font-size:16px; line-height:1; transition:transform .15s; }
  details[open] summary::after { transform:rotate(90deg); }
  details ol { margin:10px 0 0; padding-left:20px; }
  details li { margin:4px 0; }
  .seg { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:4px; padding:4px; background:var(--soft); border-radius:14px; border:1px solid var(--line); }
  .seg input { position:absolute; opacity:0; pointer-events:none; }
  .seg label { display:block; text-align:center; padding:9px 2px; border-radius:10px; font-size:13px; font-weight:550; color:var(--muted); cursor:pointer;
               white-space:nowrap; transition:background .15s, color .15s, box-shadow .15s; }
  .seg label:hover { color:var(--fg); }
  .seg input:checked + label { background:var(--card); color:var(--fg); box-shadow:0 1px 2px rgba(15,29,34,.08), 0 0 0 1px var(--line); }
  .seg input:focus-visible + label { outline:2px solid var(--focus); outline-offset:1px; }
  .hint { font-size:12.5px; color:var(--faint); margin:8px 0 0; }
  .btn {
    display:flex; align-items:center; justify-content:center; gap:10px; width:100%; height:50px; margin-top:24px; border:0; border-radius:14px;
    background:var(--btn); color:var(--btn-fg); font-size:15.5px; font-weight:650; cursor:pointer; text-decoration:none;
    transition:background .15s, transform .05s;
  }
  .btn:hover { background:var(--btn-hover); }
  .btn:active { transform:translateY(1px); }
  .btn:focus-visible { outline:3px solid var(--focus); outline-offset:2px; }
  .btn.secondary { background:transparent; color:var(--fg); border:1px solid var(--line); height:44px; margin-top:16px; font-weight:600; }
  .btn.secondary:hover { background:var(--soft); }
  code { font:13px ui-monospace,SFMono-Regular,Menlo,monospace; padding:2px 7px; border-radius:7px; background:var(--soft); border:1px solid var(--line); word-break:break-all; }
  .copy { display:block; padding:12px 14px; border-radius:14px; font-size:14px; text-align:center; user-select:all; -webkit-user-select:all; cursor:text; }
  .apps { display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); gap:10px; margin-top:16px; }
  .app { padding:14px 16px; border-radius:16px; background:var(--soft); border:1px solid var(--line); }
  .app h2 { font-size:14px; margin:0 0 8px; font-weight:650; }
  .app ol { margin:0; padding-left:18px; font-size:13px; color:var(--muted); }
  .app li { margin:3px 0; }
  .app b { color:var(--fg); font-weight:600; }
  a { color:var(--teal-2); text-underline-offset:2px; }
  .sessions { list-style:none; margin:0; padding:0; border:1px solid var(--line); border-radius:18px; overflow:hidden; }
  .sessions li { display:flex; gap:16px; align-items:center; padding:14px 16px; }
  .sessions li + li { border-top:1px solid var(--line); }
  .sessions .meta { flex:1; min-width:0; }
  .sessions .name { font-weight:600; }
  .sessions .dates { color:var(--muted); font-size:12.5px; }
  .sessions form { margin:0; }
  .sessions button { height:34px; padding:0 12px; border-radius:10px; border:1px solid var(--line); background:transparent; color:var(--err); font-weight:600; cursor:pointer; }
  .sessions button:hover { background:var(--err-bg); }
  footer { display:flex; align-items:center; justify-content:center; gap:8px; flex-wrap:wrap; padding:16px 24px; border-top:1px solid var(--line);
           color:var(--faint); font-size:12.5px; text-align:center; }
  footer .ic { width:14px; height:14px; }
  footer a { color:var(--muted); }
  footer a.gh { display:inline-flex; align-items:center; gap:4px; }
  .dot { opacity:.5; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

function card(inner: string, opts: { title: string; subtitle?: string; wide?: boolean }) {
  return `<main${opts.wide ? ' class="wide"' : ""}>
  <div class="inner">
    <div class="hero">
      <img src="${A.png}" alt="Wise MCP">
      <h1>${esc(opts.title)}</h1>
      <p class="sub">${opts.subtitle ?? `Personal connector by <a class="brand" href="${WEBSITE}" target="_blank" rel="noopener">BlanketByte</a>`}</p>
      <span class="notice">${icon("info")}Not operated by Wise</span>
    </div>
    ${inner}
  </div>
  <footer>${icon("lock")}<span>Token encrypted at rest</span><span class="dot">·</span><a href="/sessions">Manage sessions</a><span class="dot">·</span><a class="gh" href="${REPO_URL}" target="_blank" rel="noopener">${icon("github")}Source</a></footer>
</main>`;
}

/** Red banner shown on every page served over plain HTTP (except localhost). */
export const INSECURE_BANNER = `<div class="insecure" role="alert">${icon("alert")}<div><strong>Not secure: this page uses HTTP, not HTTPS</strong>Don't paste your Wise token here: anyone on the network could read it. Turn on HTTPS for this domain (e.g. Let's Encrypt in Dokploy or Easypanel), then reload over https://.</div></div>`;

const alert = (kind: "err" | "ok", html: string) =>
  `<div class="alert ${kind}" role="${kind === "err" ? "alert" : "status"}">${icon(kind === "err" ? "alert" : "check")}<div>${html}</div></div>`;

const TOKEN_STEPS = `<details>
  <summary>Where do I find my token?</summary>
  <ol>
    <li>Open Wise → Settings → <a href="https://wise.com/settings/api-tokens" target="_blank" rel="noopener">API tokens</a>.</li>
    <li>Add a new token${config.WRITES_ENABLED ? `: <b>Full access</b> to prepare transfers and recipients, or <b>Read only</b> for answers only` : ` with <b>Read only</b> access`}.</li>
    <li>Copy it and paste it here. It's shown only once.</li>
  </ol>
</details>`;

function permissions() {
  const rows = [
    ["eye", "Read your accounts", "Balances, Jars, card payments, transfers, recipients"],
    ...(config.WRITES_ENABLED
      ? [
          ["arrows", "Prepare transfers and recipients", "You approve every change in chat first"],
          ["hand", "You stay in control of money", "Transfers are only paid when you pay them in the Wise app"],
        ]
      : [["shield", "Read-only", "This connector can't move money"]]),
  ];
  return `<ul class="perms">${rows
    .map(([ic, title, text]) => `<li><span class="chip">${icon(ic)}</span><div><strong>${title}</strong><span>${text}</span></div></li>`)
    .join("")}</ul>`;
}

export function loginPage(opts: { loginId: string; clientName?: string; error?: string }) {
  const seg = SESSION_CHOICES.map(
    (c) =>
      `<input type="radio" id="ttl-${c.value}" name="ttl" value="${c.value}"${c.value === DEFAULT_SESSION_CHOICE ? " checked" : ""}><label for="ttl-${c.value}">${c.label}</label>`,
  ).join("");
  return layout(
    "Connect Wise",
    card(
      `${permissions()}
    ${opts.error ? alert("err", esc(opts.error)) : ""}
    <form method="post" action="/login">
      <input type="hidden" name="login_id" value="${esc(opts.loginId)}">
      <div class="field">
        <label class="lbl" for="token">Wise API token</label>
        <div class="input">${icon("key")}<input id="token" name="token" type="password" required autofocus autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"></div>
        ${TOKEN_STEPS}
      </div>
      <div class="field">
        <span class="lbl" id="ttl-label">Stay connected for</span>
        <div class="seg" role="radiogroup" aria-labelledby="ttl-label">${seg}</div>
        <p class="hint">"Always" keeps you connected until you revoke access.</p>
      </div>
      <button class="btn" type="submit">Connect Wise</button>
    </form>`,
      { title: `Connect Wise to ${opts.clientName ?? "your app"}` },
    ),
  );
}

export function sessionsLoginPage(error?: string) {
  return layout(
    "Wise MCP sessions",
    card(
      `<p class="muted" style="text-align:center">Paste a Wise API token for your account to see and revoke connected sessions (Claude, ChatGPT, …). It's only used to check who you are and is never stored.</p>
    ${error ? alert("err", esc(error)) : ""}
    <form method="post" action="/sessions/login">
      <div class="field">
        <label class="lbl" for="token">Wise API token</label>
        <div class="input">${icon("key")}<input id="token" name="token" type="password" required autofocus autocomplete="off" autocapitalize="off" spellcheck="false"></div>
      </div>
      <button class="btn" type="submit">Sign in</button>
    </form>`,
      { title: "Your sessions" },
    ),
  );
}

export function messagePage(title: string, message: string, kind: "err" | "ok" = "err") {
  return layout(title, card(alert(kind, message), { title }));
}

export function sessionsPage(opts: { userName?: string; sessions: Session[]; flash?: string }) {
  const fmt = (t: number | null) => (t === null ? "never" : new Date(t).toISOString().slice(0, 16).replace("T", " "));
  const rows = opts.sessions
    .map(
      (s) => `<li>
        <div class="meta">
          <div class="name">${esc(s.clientName ?? s.clientId.slice(0, 8))}</div>
          <div class="dates">Connected ${fmt(s.createdAt)} · last used ${fmt(s.lastUsedAt)} · expires ${fmt(s.expiresAt)}</div>
        </div>
        <form method="post" action="/sessions/revoke"><input type="hidden" name="id" value="${esc(s.id)}"><button>Revoke</button></form>
      </li>`,
    )
    .join("");
  return layout(
    "Wise MCP sessions",
    card(
      `${opts.flash ? alert("ok", esc(opts.flash)) : ""}
    ${
      opts.sessions.length
        ? `<ul class="sessions">${rows}</ul>
           <form method="post" action="/sessions/revoke"><input type="hidden" name="id" value="*"><button class="btn secondary" type="submit">${icon("logout")}Revoke all sessions</button></form>`
        : `<p class="muted" style="text-align:center">No active sessions.</p>`
    }`,
      { title: "Your sessions", subtitle: `Signed in as <b>${esc(opts.userName ?? "Wise user")}</b> · times in UTC`, wide: true },
    ),
  );
}

export function homePage(mcpUrl: string) {
  return layout(
    "Wise MCP",
    card(
      `<p class="muted" style="text-align:center;margin-bottom:10px">Your connector address</p>
    <code class="copy">${esc(mcpUrl)}</code>
    <div class="apps">
      <div class="app">
        <h2>Claude</h2>
        <ol>
          <li><b>Settings → Connectors</b></li>
          <li><b>Add custom connector</b></li>
          <li>Paste the address, then sign in with your Wise token</li>
        </ol>
      </div>
      <div class="app">
        <h2>ChatGPT</h2>
        <ol>
          <li><b>Settings → Apps &amp; Connectors</b></li>
          <li>Turn on <b>Developer mode</b> (Advanced), then <b>Create</b></li>
          <li>Paste the address, choose <b>OAuth</b>, then sign in with your Wise token</li>
        </ol>
      </div>
    </div>`,
      { title: "Wise MCP" },
    ),
  );
}
