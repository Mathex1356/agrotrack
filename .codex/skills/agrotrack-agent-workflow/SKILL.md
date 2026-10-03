---
name: agrotrack-agent-workflow
description: Classify AgroTrack engineering tasks and coordinate Planner, Executor and Reviewer roles for non-trivial work, with delegation proportional to risk and useful parallelism.
---

# AgroTrack agent workflow

Use this workflow to choose between direct execution and multi-agent coordination. Read applicable AGENTS.md instructions before classifying or delegating work. User scope, exclusions and execution permissions remain authoritative.

## 1. Classify the task

Classify before creating subagents and state the classification with a brief reason.

**Trivial:** a small, localized, low-risk change with clearly defined behavior, involving no architecture, security, multi-tenancy, migration or concurrency decisions.

- Do not create subagents by default. The main agent may execute directly.
- Still follow AGENTS.md and applicable skills.

**Non-trivial:** implementation across multiple files or involving technical decisions, meaningful behavior changes, authentication/authorization, multi-tenancy, database changes, migrations, constraints, concurrency, architecture or material regression risk.

- Use Planner -> Executor -> Reviewer, with the Leader evaluating each handoff.
- Evaluate whether delegation adds value; avoid redundant agents and excessive coordination.
- Respect explicit requests for planning-only, review-only or no implementation. Stop at the authorized stage.
- If delegation is unavailable or prohibited by governing instructions, disclose the limitation and perform the authorized stages sequentially in the main agent, without claiming independent subagent review.

## 2. Leader: scope and coordinate

The main agent is the Leader and remains responsible for the final result.

- Give each subagent a bounded task, expected output, relevant file locations, applicable skills and explicit restrictions. Share only the context needed, including approved decisions and dependencies.
- Check available delegation tools and concurrency limits; do not assume fixed agent counts or background persistence.
- Planner, Executor and Reviewer are roles defined by instructions, not native agent types. Behavioral restrictions do not technically remove tools from a subagent.
- Agents may share the workspace. Assign file ownership when needed, preserve existing user changes and prevent conflicting writes.
- Evaluate evidence and outputs rather than accepting them automatically. Resolve disagreements against requirements, repository contracts and validation results.
- Approval of a plan means the Leader has accepted it within the user's authorized scope. Ask the user only when an unresolved decision or action requires their input or permission; routine handoffs do not require repeated confirmation.

## 3. Planner: investigate and plan

The Planner must not modify files by default.

- Inspect the current implementation and only relevant documentation: domain-model for business decisions, physical-model for database structure/invariants, and README for commands and environment conventions.
- Use [agrotrack-task](../agrotrack-task/SKILL.md) for investigation and planning, plus other applicable skills. Do not proceed to implementation merely because a referenced skill includes that stage.
- Identify requirements, exclusions, constraints, tenant boundaries, risks and unresolved decisions. Preserve approved architectural decisions.
- Deliver a technical plan naming affected areas, implementation steps, acceptance criteria and required validations, with evidence for important assumptions.

The Leader must resolve blocking ambiguities before handing off. A plan is sufficiently defined when its scope, behavior, invariants and validation strategy are actionable; do not invent answers to decisions requiring user input.

## 4. Executor: implement the accepted plan

Start only after the Leader has accepted a sufficiently defined plan and implementation is authorized.

- Follow AGENTS.md, [agrotrack-task](../agrotrack-task/SKILL.md) and other applicable skills.
- Implement the focused plan using existing architecture and dependencies.
- Do not silently expand scope. Report necessary deviations and their reasons to the Leader before proceeding with changes that alter behavior, architecture or risk.
- Run appropriate validations, starting focused and broadening as justified. Fix failures caused by the change and rerun affected checks.
- Return changed areas, implemented behavior, deviations, validation commands/results and remaining limitations.

## 5. Reviewer: independently review the implementation

Start after the Executor finishes. Review the actual implementation and diff independently from the author's conclusions.

- Follow AGENTS.md and [agrotrack-review](../agrotrack-review/SKILL.md).
- Check correctness, scope, tenant isolation, database integrity, security, regression risk, tests and documentation as applicable.
- Distinguish confirmed defects, meaningful risks and optional improvements. Ground findings in concrete evidence and propose corrections.
- Do not modify the implementation during review unless explicitly requested. Run focused validation when permitted and useful; respect read-only restrictions.
- Report findings, validations performed and residual areas not exercised. Do not equate a clean review with guarantees beyond the evidence.

The Leader evaluates findings and sends accepted corrections to the Executor. After corrections, rerun affected validations and obtain focused Reviewer reassessment where needed. Escalate unresolved decisions rather than looping without progress; do not claim completion while material defects remain unresolved.

## 6. Parallel specialists

Use parallel specialists only for independent subtasks that benefit from separate investigation, such as security analysis, database analysis, test investigation or architectural research.

- Define bounded outputs and minimize overlap; do not create specialists merely to increase the number of agents.
- Keep dependent tasks sequential. Do not start execution before its plan or review before the implementation is ready.
- Integrate specialist findings at the relevant handoff. Specialists do not replace the Leader's judgment or the final implementation review.

## 7. Database and invariant work

When work involves Prisma, PostgreSQL, PostGIS, migrations, constraints, triggers, indexes, concurrency or integrity, the relevant agents must use [database-change](../database-change/SKILL.md).

- Inspect schema, relevant versioned SQL and physical-model; Prisma does not represent every invariant.
- Never alter applied migrations or substitute `prisma db push` for versioned migrations.
- Preserve tenant consistency, composite foreign keys, RESTRICT behavior, intentional SQL/PostGIS behavior and existing invariants unless an authorized architectural change explicitly changes them.
- Distinguish structural integrity from user authorization and application-level enforcement. Validate concurrent behavior for concurrency-sensitive rules.

## 8. Final validation and report

The Leader confirms that validations cover the final changes. Reuse applicable results; rerun checks after changes that invalidate them. Report checks that could not be executed and their practical limits.

For multi-agent workflows, summarize concisely:

- plan used and any accepted deviations;
- implementation completed;
- review findings and their resolution;
- validations executed and results;
- limitations or pending decisions;
- agents and skills used when they clarify the work.

This workflow uses available Codex delegation capabilities and has no dependency on Oh My Codex/OMX. It does not install tools, grant permissions or override task restrictions.
