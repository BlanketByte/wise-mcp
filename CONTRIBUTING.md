# Contributing

Thanks for helping! Issues and pull requests are welcome.

## Before you open an issue

- Search existing issues first.
- **Never paste Wise tokens, account numbers, balances or real transactions.** Redact them.
- Security problems go through [private reporting](SECURITY.md), not issues.

## Development

```bash
npm install
npm test            # typecheck + both end-to-end suites (no Wise account needed, they use a mock)
npm run dev         # remote server with hot reload (needs the env vars from .env.example)
```

## Pull requests

- Keep each PR focused on one change, and describe what it fixes or adds.
- `npm test` must pass. Add or update checks in `scripts/e2e.ts` / `scripts/e2e-stdio.ts` for new behaviour.
- Anything that writes to Wise must keep the two-step flow: `prepare_*` returns a summary and code, `confirm_action` performs it.
- Don't add dependencies unless they're clearly needed.

By contributing you agree your work is released under the [MIT license](LICENSE).
