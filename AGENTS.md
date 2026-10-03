# AgroTrack repository guidance

AgroTrack is a multi-tenant agricultural management system organized as an npm workspaces monorepo.

## Repository map

- `apps/api`: NestJS API, Prisma and PostgreSQL/PostGIS integration.
- `apps/web`: React + TypeScript + Vite frontend.
- `docs/architecture/domain-model.md`: approved domain decisions and business concepts.
- `docs/architecture/physical-model-sprint1.md`: current physical database design, constraints and known enforcement limits.
- `apps/api/prisma/schema.prisma`: Prisma schema.
- `apps/api/prisma/migrations`: versioned SQL migrations.

Read only the documentation relevant to the task. Use the domain model for domain decisions and the physical model when changing database structure or invariants.

## Engineering boundaries

- Preserve tenant isolation across organizations, farms and their dependent entities.
- Do not modify an already applied migration. Add a new migration for a new database change.
- Do not replace versioned migrations with `prisma db push`.
- Preserve deliberate SQL constraints, triggers, composite foreign keys and PostGIS behavior unless the task explicitly changes the underlying architectural decision.
- Reuse the exported `PrismaModule`/`PrismaService`; do not create independent Prisma clients inside application modules.
- Keep changes within the requested task scope. Do not implement future modules merely because the schema or documentation mentions them.
- Never commit `.env`, credentials, tokens or database connection strings.
- Keep local development compatible with Windows/PowerShell. Prefer existing npm scripts and portable Node.js tooling over shell-specific commands.

## Validation

Use the smallest relevant validation while working, then run the broader checks justified by the change. Existing local tests use development fixtures and no production access.

Common commands from the repository root:

- `npm run prisma:validate` for Prisma schema changes.
- `npm run test:api` for API/database behavior.
- `npm run lint` for static checks.
- `npm run build` for the complete workspace build.
- `npm run db:check` when the task changes or depends on real database infrastructure.

When a requested change causes a validation failure, fix failures caused by that change and rerun the affected validation.

## Working style

Before a non-trivial implementation, inspect the existing implementation and state a concise plan. Preserve existing architecture unless the task explicitly requires changing it.

When finishing, report:
1. what changed;
2. why it changed;
3. validations run and their results;
4. any remaining limitation or intentionally deferred work.
