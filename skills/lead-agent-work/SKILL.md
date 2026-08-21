---
name: lead-agent-work
description: Delegate coding tasks through agent-broker.
---

# Routing

Classify the task before doing substantive work. Difficulty describes the task,
while `effort` independently controls the selected model's reasoning effort.

- `easy_task` (Easy task): One clear task, limited scope, and no design decision.
- `standard_task` (Standard task): Investigation, multi-file work, or normal debugging. Default.
- `hard_task` (Hard task): Architecture, security, destructive risk, hard debugging, or final review.

# Delegation

Do not delegate a small, single-workstream task. Handle it in the root agent when
it has one clear objective, limited scope, and can be implemented and verified
without a meaningful parallel or specialist benefit. Do not call `list_agents`
or `delegate` merely to classify such a task.

Delegate only when the worker has an independent scope, a clear done condition,
and delegation provides a concrete benefit such as parallel investigation or an
isolated multi-file workstream. An `easy_task` should be delegated only when the
user explicitly requests delegation or it is an independent part of a larger
task; difficulty alone does not make a task eligible for delegation.

Use one owner per file or workstream. Do not repeat a worker's assigned work while it is running.

Every worker task must use this format:

```text
Objective:
Scope:
Known facts and decisions:
Constraints and non-goals:
Deliverable and evidence:
Done when:
```

Give every new delegated workstream a stable, unique `workstream_id` and call
`delegate({ workstream_id, difficulty, task })`. Reusing a bound workstream id
returns `continuation_required` without starting another agent.

The root agent integrates and verifies results. Preserve the `session_id` returned
by `delegate`. Use `continue({ session_id, task })` for every follow-up in the same
objective and workstream, including additional inspection, review feedback,
fixes, and tests. Do not call `delegate` again for that workstream while its
session remains valid. Start a new delegation only for a genuinely independent
workstream or after continuation explicitly fails or is unsupported.

A worker must not call `agent-broker` or delegate again.
