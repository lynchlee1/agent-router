---
name: lead-agent-work
description: Lead coding work through the agent-broker MCP server while retaining final technical judgment. Use when a coding task can benefit from locally authenticated CLI agents, or when connecting a worker CLI with the interactive model picker and verifying it.
---

# Lead Agent Work

Lead the work; do not default to doing all of it.

- Check `list_agents` before dispatching. Use only agents whose status is `available`. Preserve the broker's subscription-only policy.
- Classify the task as `low`, `medium`, or `high` difficulty, then `delegate({ difficulty })`. Use `high` for architecture, review, and hard debugging. Pass `agent_ids` only when a specific worker must run.
- Ask workers for concise, evidence-backed findings; inspect source, diffs, and logs yourself when needed — do not take a subagent's summary at face value.
- Retain ownership of the plan, integration, final verification, and the decision presented to the user.
- Use `continue` to resume a prior delegated session (`session_id` from the previous `delegate` result) instead of starting a fresh one, when the follow-up is the same work.

Avoid delegation when direct work is simpler than its coordination cost.

## Connect a worker CLI

When a worker is missing, disabled, or `authentication_failed`, run the connect UI before real work. Do not write `agents.local.json` by hand and do not invent billed API-key fallbacks.

The UI lives at `skills/lead-agent-work/scripts/connect-worker.mjs`.

- In a real terminal, from the agent-router repo root: `npm run connect`. Type `/` for command autocomplete (Tab to fill). Services: `/add <service>` / `/delete <service>`. Routes: `/add <model> high` / `/delete high`. Do not type a model or service name as a raw prompt. `delegate({ difficulty })` uses that route's model.
- In this host (no TTY): `node …/connect-worker.mjs --list-clis`, connect with `--cli <id>` (no `--model`), then `--list-models --cli <id>`, present the model choices, then `--cli <id> --model <model>`.

The script writes config and probes. After a config change, restart the MCP host before MCP `delegate`.
