# Contributing to Coeval

Thanks for helping improve Coeval. Focused fixes, tests, documentation improvements, and narrowly scoped features are welcome.

## Development setup

You need Node.js 24+, pnpm 10.33+, and Docker for database-backed work.

```bash
pnpm install
cp .env.example .env
docker compose -f docker-compose.pg.yml up -d
```

Generate a local `BETTER_AUTH_SECRET`, add it to `.env`, then start the API and web app as described in [README.md](README.md).

## Checks

Run these before submitting a pull request:

```bash
pnpm typecheck
pnpm test
pnpm --filter @coeval/web build
git diff --check
```

When your change touches persistence, migrations, authentication, queues, or project authorization, also run the Postgres-backed tests:

```bash
pnpm test:pg
```

The command owns a disposable PostgreSQL 17 container and removes it after the
run. Set `PG_SMOKE_DATABASE_URL` only to use an existing local server.

## Pull requests

- Keep each pull request centered on one problem.
- Add tests for behavior changes and regressions.
- Preserve append-only verdict history and immutable skill versions.
- Treat evaluated trace content as untrusted input.
- Never turn provider, queue, or timeout failures into passing judgments.
- Do not add generated files, credentials, local `.env` files, or files from `.private/`.
- Update public documentation when an API or operator workflow changes.

For UI changes, include the flow and states you exercised manually. For schema
changes, explain the clean-baseline change and invariant coverage; do not add
upgrade or rollback machinery before the first external deployment.

## Reporting security issues

Do not open a public issue for a vulnerability. Follow [SECURITY.md](SECURITY.md).
