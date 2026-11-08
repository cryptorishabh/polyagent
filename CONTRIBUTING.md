# Contributing

```bash
npm install
npm test        # unit + e2e against fake CLIs; spends no tokens
npm run typecheck
```

- **Tests never call real models.** `test/fake-clis/fake-agent.mjs` stands in for every CLI. Its behaviour per task and attempt is scripted (`ok`, `bad`, `ratelimit`, `sleep`, `delegate`, …).
- **New provider:** add an adapter in `src/adapters/index.ts` (build args, parse output, detect rate limits), add the id to `PROVIDERS`, add defaults in `src/config.ts`, and cover its parser with a fake-agent output format.
- **CLI flags change often.** If a vendor renames a flag, update the adapter and say so in `CHANGELOG.md`.
- Source is TypeScript with erasable syntax only (Node runs it directly in tests). No runtime dependencies, please.
