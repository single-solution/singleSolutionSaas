# Rules alignment audit

Date: 2026-07-10

Scope: migration-verification integration gate on uncommitted remediation diff.

## Project follows rules

| Rule area | Status | Notes |
| --- | --- | --- |
| API design (noun paths, handler flow) | Aligned | Cron routes under `/api/crons/*`; internal under `/api/internal/*` |
| Naming (descriptive identifiers) | Aligned | Violations fixed in touched files (`tenant.ts` CRLF) |
| Security (secrets, cron auth, encryption) | Aligned | Config encryption, SSO exchange, embed sessions |
| Documentation (README domain + docs/) | Aligned | README exhaustive; setup/deploy/go-live updated |
| Migrations (dry-run, idempotent) | Aligned | All scripts default dry-run; batch limits added |
| Caching (Redis in production) | Aligned | Required in prod env schemas |
| Logging (structured, redacted) | Aligned | `lib/logging/*` on both deployables |
| OpenAPI contract | Aligned | `contracts/openapi.yaml` + `docs/api.md` |
| CI (lint, typecheck, build, audit) | Aligned | Two-job workflow for platform + product |
| Testing pyramid | Gap | No automated tests in this pass (explicitly deferred) |
| Docker | N/A | Not used |

## Gaps with owners

| Gap | Owner | Target |
| --- | --- | --- |
| Embedded message array cleanup (phase 2) | Product | After Message migration verified in prod |
| DNS TXT domain verification | Platform | Future hardening |
| Payment provider | Platform | Post-MVP billing |
| Duplicate Mongoose index warning (`expiresAt`) | Platform | Low priority; cosmetic at build |

## Promote upstream

| Pattern | Recommendation |
| --- | --- |
| Migration dry-run + `--apply` + JSON counts | Already in rulebook maintenance guidance |
| Dual-read data migration without first-pass delete | Document as ADR if repeated across projects |
| SSO one-time exchange collection | Product-specific; keep in project docs |

## Verification performed

- Root and product: `lint`, `typecheck`, `build`
- `git diff --check` after `tenant.ts` fix
- `npm run validate:openapi`
- `npm audit --audit-level=high` (both packages)
- Migration scripts: dry-run / static validation only

## Next audit

Diff against this checklist after next behavior-changing release or quarterly (whichever is sooner).
