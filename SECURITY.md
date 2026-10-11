# Security policy

This server handles Wise API tokens and can prepare money transfers, so security reports are very welcome.

## Reporting a vulnerability

Please **don't open a public issue**. Report it privately instead:
**[Report a vulnerability](https://github.com/BlanketByte/wise-mcp/security/advisories/new)** (GitHub private vulnerability reporting).

Include what you found, how to reproduce it, and the impact you expect. You'll get a reply within a few days, and a fix plus credit (if you want it) once it's resolved.

**Never include real Wise tokens, account details or transaction data** in a report. Use made-up values or the mock from `scripts/e2e.ts`.

## Supported versions

Only the latest release gets security fixes.

## In scope

- Token handling and storage (encryption at rest, retention, logging)
- The OAuth flow, sessions and `/sessions`
- The two-step write flow (anything that could create a transfer, recipient or cancellation without explicit confirmation)
- Local (stdio) mode and the Claude Desktop extension

Issues in Wise's API itself should go to [Wise](https://wise.com/help/).
