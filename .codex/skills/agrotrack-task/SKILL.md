---
name: agrotrack-task
description: Implement a scoped AgroTrack feature or engineering task while preserving the repository architecture, tenant boundaries, documentation decisions, and validation workflow. Use for normal AgroTrack implementation tasks that are larger than a trivial edit.
---

# AgroTrack task workflow

Use this workflow for a normal scoped implementation in AgroTrack.

## 1. Understand the task

Identify the requested deliverable and explicit exclusions. Do not expand the task into future modules or speculative improvements.

## 2. Inspect relevant context

Inspect the existing code before editing it.

Load only the documentation relevant to the change:
- use `docs/architecture/domain-model.md` for domain/business decisions;
- use `docs/architecture/physical-model-sprint1.md` for current database structure, constraints and known enforcement limits;
- use the README for repository commands and environment conventions.

If the task changes the database, also use the `database-change` skill.

## 3. Plan

For non-trivial work, state a concise implementation plan before editing. Identify affected layers such as API, database, tests, frontend or documentation.

Call out tenant boundaries or architectural invariants that the implementation must preserve.

## 4. Implement

Prefer the existing project patterns and dependencies. Keep the diff focused.

Do not implement adjacent backlog items unless they are required for correctness of the requested task.

## 5. Validate

Run the validations relevant to the changed layers. Start focused and broaden when justified.

For API/database behavior, prefer existing integration tests over assumptions.

## 6. Finish

Summarize:
- files/areas changed;
- behavior implemented;
- validations executed and results;
- known limitations or deferred work.

Do not claim an invariant is enforced unless code, database structure or tests actually enforce it.
