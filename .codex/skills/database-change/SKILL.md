---
name: database-change
description: Design or review AgroTrack Prisma, PostgreSQL, PostGIS, migration, constraint, index, foreign-key, trigger, seed, or database-concurrency changes. Use whenever a task changes database structure or database-enforced invariants.
---

# AgroTrack database change workflow

Database changes in AgroTrack must preserve multi-tenant integrity and the intent of existing versioned migrations.

## Before editing

1. Inspect `apps/api/prisma/schema.prisma`.
2. Inspect the relevant existing migrations rather than assuming the Prisma schema represents every database invariant.
3. Read the relevant sections of `docs/architecture/physical-model-sprint1.md`.
4. Read `docs/architecture/domain-model.md` when the change depends on a domain decision.

## Design rules

- Preserve organization/farm consistency and tenant isolation.
- Prefer explicit database enforcement for structural invariants where the current architecture does so.
- Remember that Prisma does not represent every PostgreSQL/PostGIS constraint or trigger used by this repository.
- Preserve RESTRICT behavior and existing composite foreign-key strategy unless an approved design change requires otherwise.
- Treat PostGIS geometry, concurrency controls and manual SQL triggers/checks as intentional architecture, not disposable generated code.
- Distinguish database integrity from application authorization; a foreign key or trigger does not prove a user is authorized.

## Migration rules

- Never edit an already applied migration.
- Never use `prisma db push` as a substitute for a versioned migration.
- Add a new migration for a new schema/invariant change.
- Review generated SQL and add manual SQL only when required by the design.
- Keep migrations safe for existing data or explicitly report when a data migration/backfill is required.
- Do not reset or remove the developer database volume unless the user explicitly requests destructive local reset behavior.

## Validation

As applicable, run:
- `npm run prisma:format`;
- `npm run prisma:validate`;
- `npm run db:migrate`;
- `npm run prisma:generate`;
- focused integration tests;
- `npm run test:api`;
- `npm run lint`;
- relevant build commands;
- `npm run db:check` for real infrastructure verification.

For concurrency-sensitive invariants, validate concurrent behavior rather than relying only on sequential tests.

## Completion report

State separately:
- what Prisma represents;
- what manual SQL enforces;
- what remains application-level enforcement;
- which tests demonstrate the behavior.
