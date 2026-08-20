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

Call `delegate({ difficulty, task })` before starting the assigned work.

Delegate only work with an independent scope and a clear done condition. Otherwise, do it in the root agent.

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

The root agent integrates and verifies results. Use `continue` for follow-up work on the same task.

A worker must not call `agent-broker` or delegate again.
