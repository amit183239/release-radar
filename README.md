# Release Radar

**A queryable, per-app release changelog for a GitHub monorepo — with a dual-persona
(developer + customer-support) read surface behind SSO.**

Release Radar *pulls* from GitHub on a schedule and gives two audiences what they need:

- **Developers** get a queryable, per-app changelog of what actually shipped to
  production, attributed down to the contributing pull requests.
- **Support / CX** get plain-language, per-product "what shipped" awareness and
  close-the-loop notifications when a customer's reported bug or feature ships.

It touches no app's release workflow, works retroactively (it backfills history), and
is SSO-gated to your organization's email domain.

## How it works

Release Radar is a single **Cloudflare Worker** (Hono) + **D1** database. A cron-driven
poll reads the GitHub API with a fine-grained, read-only token:

1. Lists an app's production tags and orders them by **tag-creation time** — the only
   reliable deploy-order signal in a repo that deploys from arbitrary branches.
2. Chains consecutive tags and runs a three-dot `compare` on each pair to find exactly
   what that deploy added over the previous one.
3. Enumerates the contributing PRs from squash-merge commit subjects and scopes each
   release to its app(s) by changed path.
4. Serves it all through a login-gated read API.

No GitHub App, no webhooks, no changes to any repository's CI. The poll self-heals:
every tick re-scans state, so a missed change is picked up on the next run.

## Configure it for your repo

Everything repo- or org-specific is configuration (`wrangler.*.toml` `[vars]`), not
code:

| Var | Meaning | Example |
| --- | --- | --- |
| `GITHUB_REPO` | The `owner/repo` to read | `acme/monorepo` |
| `RELEASE_TAG_PATTERN` | Production tag glob (`{app}` = app slug) | `{app}-*-production` |
| `MAPPING_JSON_PATH` | Path → app map, fetched via the API | `.github/mapping.json` |
| `ALLOWED_EMAIL_DOMAINS` | SSO allow-list (comma-separated, fail-closed) | `example.com` |
| `SHARED_LIB_BUCKET` | Umbrella bucket for shared-lib changes | `platform` |
| `BACKFILL_DAYS` | History window to bootstrap | `90` |

Auth is pluggable through an `AuthProvider` seam (OAuth SSO is the bundled
implementation); AI-generated customer copy is behind a provider seam with an `off`
mode, so the developer changelog works with zero AI configured.

## Develop

```bash
npm install
npm run typecheck
npm test
npm run dev   # requires a D1 database id in wrangler.toml and a .dev.vars (see .dev.vars.example)
```

## Status

v1 is under active development. The Phase-1 ingestion core (poll, chained tag
attribution, app scoping, SSO gate, backfill) is implemented; the developer changelog
UI, follow/feed, and the CX lens are in progress. See `CLAUDE.md` for the phase map.

## License

Apache-2.0. See [`LICENSE`](./LICENSE).
