## What and why

<!-- One paragraph. Link the work package or issue. -->

## How to verify

<!-- Commands a reviewer can run. -->

```bash
pnpm run -s verify
```

## Checklist

- [ ] Conventional commit messages, every commit signed off (`git commit -s`)
- [ ] **No secrets** — no token, credential or customer data in code, docs, tests, fixtures or CI logs (BD-002); fixtures use obviously fake values
- [ ] Tests added or updated for the tier this change belongs to (docs/technical/10-testing-strategy.md)
- [ ] `.env.example` updated if a new environment variable was introduced
- [ ] Docs updated (`docs/**`, `CLAUDE.md`) if behaviour or conventions changed
