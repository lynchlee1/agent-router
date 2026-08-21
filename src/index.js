import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  normalizeTaskDifficulty,
  TASK_DIFFICULTY_VALUES,
} from './task-difficulty.js';

export {
  DEFAULT_TASK_DIFFICULTY,
  normalizeTaskDifficulty,
  TASK_DIFFICULTIES,
  TASK_DIFFICULTY_VALUES,
  taskDifficulty,
  taskDifficultyFromCommand,
} from './task-difficulty.js';

const API_KEY_NAME = /_API_KEY$/i;
const TEMPLATE_VALUES = new Set(['{{prompt}}', '{{session_id}}', '{{cwd}}']);
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const PROBE_TIMEOUT_MS = 5 * 1000;
const MAX_CAPTURE_BYTES = 1024 * 1024;
const BROKER_DEPTH_NAME = 'AGENT_BROKER_DEPTH';

function modelFromArgs(args = []) {
  const index = args.indexOf('--model');
  return index >= 0 && typeof args[index + 1] === 'string' ? args[index + 1] : undefined;
}

function normalizeRouteList(routes) {
  if (!Array.isArray(routes)) return [];
  const byDifficulty = new Map();
  for (const route of routes) {
    if (!route || typeof route !== 'object' || Array.isArray(route)) continue;
    if (!TASK_DIFFICULTY_VALUES.includes(route.difficulty)) {
      throw new TypeError(`route difficulty must be one of: ${TASK_DIFFICULTY_VALUES.join(', ')}.`);
    }
    if (typeof route.model !== 'string' || !route.model.trim()) continue;
    byDifficulty.set(route.difficulty, {
      difficulty: route.difficulty,
      model: route.model.trim(),
      ...(typeof route.effort === 'string' && route.effort.trim()
        ? { effort: route.effort.trim() }
        : {}),
    });
  }
  return TASK_DIFFICULTY_VALUES.map((difficulty) => byDifficulty.get(difficulty)).filter(Boolean);
}

export function routesFrom(agent) {
  return normalizeRouteList(agent.routes);
}

export function upsertRoute(routes, { difficulty, model, effort, clear = false } = {}) {
  const key = normalizeTaskDifficulty(difficulty);
  const byDifficulty = new Map(normalizeRouteList(routes).map((route) => [route.difficulty, route]));
  if (clear) byDifficulty.delete(key);
  else if (typeof model === 'string' && model.trim()) {
    byDifficulty.set(key, {
      difficulty: key,
      model: model.trim(),
      ...(typeof effort === 'string' && effort.trim() ? { effort: effort.trim() } : {}),
    });
  }
  return TASK_DIFFICULTY_VALUES.map((item) => byDifficulty.get(item)).filter(Boolean);
}

export function modelForDifficulty(agent, difficulty) {
  const routed = difficulty
    ? routesFrom(agent).find((route) => route.difficulty === difficulty)?.model
    : undefined;
  return routed ?? agent.model ?? modelFromArgs(agent.args);
}

export function effortForDifficulty(agent, difficulty) {
  return difficulty
    ? routesFrom(agent).find((route) => route.difficulty === difficulty)?.effort
    : undefined;
}

function agentHandlesDifficulty(agent, difficulty) {
  if (agent.model || modelFromArgs(agent.args)) return true;
  const routes = routesFrom(agent);
  return !routes.length || routes.some((route) => route.difficulty === difficulty);
}

function withModelFlag(args, model) {
  if (!model) return args;
  const next = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--model') {
      index += 1;
      continue;
    }
    next.push(args[index]);
  }
  next.push('--model', model);
  return next;
}

/**
 * Read and normalize broker configuration. `source` may be a JSON path or a
 * plain object, which keeps the core easy to exercise without an MCP host.
 */
export function loadConfig(source) {
  let raw;
  let configDir;

  if (typeof source === 'string') {
    const configPath = resolve(source);
    raw = JSON.parse(readFileSync(configPath, 'utf8'));
    configDir = dirname(configPath);
  } else if (source && typeof source === 'object') {
    raw = structuredClone(source);
    configDir = process.cwd();
  } else {
    throw new TypeError('Broker config must be a JSON file path or an object.');
  }

  if (!Array.isArray(raw.agents)) {
    throw new TypeError('Broker config must contain an agents array.');
  }

  const seenIds = new Set();
  const agents = raw.agents.map((agent) => normalizeAgent(agent, seenIds, configDir));
  const stateDir = resolvePath(
    configDir,
    raw.state_dir ?? join(homedir(), '.local', 'state', 'agent-broker'),
  );

  return {
    agents,
    state_dir: stateDir,
    timeout_ms: normalizeTimeout(raw.timeout_ms, DEFAULT_TIMEOUT_MS),
    config_dir: configDir,
  };
}

function normalizeAgent(rawAgent, seenIds, configDir) {
  if (!rawAgent || typeof rawAgent !== 'object' || Array.isArray(rawAgent)) {
    throw new TypeError('Every agent must be an object.');
  }

  const id = rawAgent.id;
  if (typeof id !== 'string' || !id.trim()) {
    throw new TypeError('Every agent needs a non-empty id.');
  }
  if (seenIds.has(id)) {
    throw new TypeError(`Duplicate agent id: ${id}`);
  }
  seenIds.add(id);
  if (rawAgent.difficulty !== undefined) {
    throw new TypeError(`Agent ${id} difficulty must be configured on routes.`);
  }

  const billing = rawAgent.billing;
  if (!billing || billing.mode !== 'subscription' || billing.fallback !== 'forbidden') {
    throw new TypeError(
      `Agent ${id} must set billing.mode to "subscription" and billing.fallback to "forbidden".`,
    );
  }

  const adapter = rawAgent.adapter ?? 'native-cli';
  if (typeof adapter !== 'string' || !adapter) {
    throw new TypeError(`Agent ${id} needs an adapter name.`);
  }
  if (!rawAgent.adapter_module && !['native-cli', 'codex-exec'].includes(adapter)) {
    throw new TypeError(
      `Agent ${id} uses unknown adapter ${adapter}; provide adapter_module for local adapters.`,
    );
  }

  const command = rawAgent.command ?? (adapter === 'codex-exec' ? 'codex' : undefined);
  if (typeof command !== 'string' || !command) {
    throw new TypeError(`Agent ${id} needs one executable command.`);
  }
  if (rawAgent.enabled !== undefined && typeof rawAgent.enabled !== 'boolean') {
    throw new TypeError(`Agent ${id} enabled must be a boolean.`);
  }

  const environment = normalizeEnvironment(rawAgent.env, id);
  const args = normalizeArgumentList(rawAgent.args ?? [], `Agent ${id} args`);
  if (adapter === 'native-cli' && !args.includes('{{prompt}}')) {
    throw new TypeError(`Agent ${id} args must include {{prompt}}.`);
  }
  if (adapter === 'native-cli' && args.includes('{{session_id}}')) {
    throw new TypeError(`Agent ${id} args may not include {{session_id}} before a session exists.`);
  }
  const resumeArgs = rawAgent.resume_args
    ? normalizeArgumentList(rawAgent.resume_args, `Agent ${id} resume_args`)
    : undefined;
  if (resumeArgs && !resumeArgs.includes('{{session_id}}')) {
    throw new TypeError(`Agent ${id} resume_args must include {{session_id}}.`);
  }
  if (resumeArgs && !resumeArgs.includes('{{prompt}}')) {
    throw new TypeError(`Agent ${id} resume_args must include {{prompt}}.`);
  }
  let probe;
  if (rawAgent.probe !== undefined) {
    if (!rawAgent.probe || typeof rawAgent.probe !== 'object' || Array.isArray(rawAgent.probe)) {
      throw new TypeError(`Agent ${id} probe must be an object.`);
    }
    const probeArgs = normalizeArgumentList(rawAgent.probe.args, `Agent ${id} probe.args`);
    if (!probeArgs.length) {
      throw new TypeError(`Agent ${id} probe.args must contain a harmless command argument.`);
    }
    if (probeArgs.some((argument) => TEMPLATE_VALUES.has(argument))) {
      throw new TypeError(`Agent ${id} probe.args may not contain task or session templates.`);
    }
    probe = { args: probeArgs };
  }

  return {
    ...rawAgent,
    id,
    adapter,
    command,
    enabled: rawAgent.enabled !== false,
    billing: { mode: 'subscription', fallback: 'forbidden' },
    env: environment,
    args,
    resume_args: resumeArgs,
    probe,
    roles: normalizeStringList(rawAgent.roles, `Agent ${id} roles`),
    models: normalizeStringList(rawAgent.models, `Agent ${id} models`),
    scarcity: rawAgent.scarcity ?? 'normal',
    quota_hint: rawAgent.quota_hint ?? 'unknown',
    continuation: rawAgent.continuation === true,
    priority: Number.isFinite(rawAgent.priority) ? rawAgent.priority : 100,
    max_concurrency: normalizePositiveInteger(rawAgent.max_concurrency, 1, `Agent ${id} max_concurrency`),
    routes: routesFrom({ ...rawAgent, args }),
    timeout_ms: normalizeTimeout(rawAgent.timeout_ms, undefined),
    adapter_module: rawAgent.adapter_module
      ? resolvePath(configDir, rawAgent.adapter_module)
      : undefined,
  };
}

function normalizeStringList(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new TypeError(`${label} must be an array of strings.`);
  }
  return value;
}

function normalizeEnvironment(value, agentId) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`Agent ${agentId} env must be an object.`);
  }

  for (const [name, envValue] of Object.entries(value)) {
    if (API_KEY_NAME.test(name)) {
      throw new TypeError(`Agent ${agentId} may not configure API-key environment variables.`);
    }
    if (typeof envValue !== 'string') {
      throw new TypeError(`Agent ${agentId} env values must be strings.`);
    }
  }
  return { ...value };
}

function normalizeArgumentList(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new TypeError(`${label} must be an array of strings.`);
  }
  for (const argument of value) {
    if (argument.includes('{{') && !TEMPLATE_VALUES.has(argument)) {
      throw new TypeError(`${label} may use only whole {{prompt}}, {{session_id}}, or {{cwd}} arguments.`);
    }
  }
  return value;
}

function normalizePositiveInteger(value, fallback, label) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive integer.`);
  }
  return value;
}

function normalizeTimeout(value, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > 60 * 60 * 1000) {
    throw new TypeError('timeout_ms must be an integer between 1 and 3600000.');
  }
  return value;
}

function resolvePath(base, target) {
  return isAbsolute(target) ? target : resolve(base, target);
}

/** A generic broker that is deliberately unaware of user conversation. */
export class AgentBroker {
  constructor(config) {
    this.config = loadConfig(config);
    this.delegationDepth = delegationDepth(process.env);
    this.active = new Map();
    this.availability = new Map();
    this.adapters = new Map();
    this.logDir = join(this.config.state_dir, 'logs');
    this.sessionFile = join(this.config.state_dir, 'sessions.json');
    mkdirSync(this.logDir, { recursive: true });
    this.sessions = this.#readSessions();
    this.workstreams = workstreamIndex(this.sessions);
    this.pendingWorkstreams = new Set();
  }

  async listAgents({ refresh = false } = {}) {
    const agents = await Promise.all(
      this.config.agents.map(async (agent) => {
        const status = refresh || !this.availability.has(agent.id)
          ? await this.#probe(agent)
          : this.availability.get(agent.id);
        return {
          id: agent.id,
          label: agent.label ?? agent.id,
          status: status.status,
          reason: status.reason,
          failure_kind: status.failure_kind,
          billing: agent.billing,
          roles: agent.roles,
          scarcity: agent.scarcity,
          quota_hint: agent.quota_hint,
          models: agent.models,
          routes: agent.routes,
          continuation: supportsContinuation(agent),
        };
      }),
    );
    return { agents };
  }

  async delegate(input = {}) {
    const task = validateTask(input.task);
    const workstreamId = normalizeWorkstreamId(input.workstream_id);
    if (!workstreamId) {
      return failure('invalid_request', 'delegate requires a non-empty workstream_id.');
    }
    if (this.delegationDepth > 0) {
      return failure('policy_rejected', 'Recursive delegation from a broker worker is disabled.');
    }
    const existingSessionId = this.workstreams.get(workstreamId);
    if (existingSessionId) {
      const saved = this.sessions[existingSessionId];
      return {
        status: 'continuation_required',
        workstream_id: workstreamId,
        session_id: existingSessionId,
        ...(saved?.agent_id ? { agent_id: saved.agent_id } : {}),
        summary: `Workstream ${workstreamId} already has session ${existingSessionId}; call continue with that session_id.`,
      };
    }
    if (this.pendingWorkstreams.has(workstreamId)) {
      return {
        status: 'busy',
        workstream_id: workstreamId,
        summary: `Workstream ${workstreamId} is already being delegated.`,
      };
    }

    this.pendingWorkstreams.add(workstreamId);
    try {
      const candidates = this.#selectCandidates(input);
      if (!candidates.length) {
        return failure('no_eligible_agent', 'No enabled subscription agent matches this delegation.');
      }

      let lastResult;
      for (const agent of candidates) {
        if ((this.active.get(agent.id) ?? 0) >= agent.max_concurrency) {
          lastResult = failure('busy', `${agent.id} is at its concurrency limit.`, agent.id);
          continue;
        }
        const readiness = await this.#probe(agent);
        if (readiness.status !== 'available') {
          lastResult = failure(readiness.failure_kind ?? readiness.status, readiness.reason, agent.id);
          continue;
        }

        const difficulty = normalizeTaskDifficulty(input.difficulty);
        const result = await this.#runAgent(agent, {
          task,
          workstream_id: workstreamId,
          cwd: normalizeCwd(input.cwd),
          timeout_ms: normalizeTimeout(input.timeout_ms, agent.timeout_ms ?? this.config.timeout_ms),
          kind: 'delegate',
          difficulty,
          model: modelForDifficulty(agent, difficulty),
          effort: effortForDifficulty(agent, difficulty),
        });
        lastResult = result;

        if (result.status === 'completed') return result;
        if (result.status !== 'quota_exhausted' || input.retry_safe !== true) return result;
      }

      return lastResult ?? failure('no_eligible_agent', 'No usable subscription agent is available.');
    } finally {
      this.pendingWorkstreams.delete(workstreamId);
    }
  }

  async continue(input = {}) {
    const sessionId = input.session_id;
    if (typeof sessionId !== 'string' || !sessionId) {
      return failure('invalid_request', 'continue requires a broker session_id.');
    }
    const task = validateTask(input.task);
    const saved = this.sessions[sessionId];
    if (!saved) {
      return failure('session_not_found', `No broker session named ${sessionId}.`);
    }
    const agent = this.config.agents.find((candidate) => candidate.id === saved.agent_id);
    if (!agent) {
      return failure('session_not_found', `The saved agent for ${sessionId} is no longer configured.`);
    }
    if (agent.adapter !== saved.adapter || (saved.adapter_identity && saved.adapter_identity !== adapterIdentity(agent))) {
      return failure('session_adapter_changed', `${agent.id} no longer uses the adapter that created ${sessionId}.`, agent.id);
    }
    if (!isSubscriptionAgent(agent)) {
      return failure('policy_rejected', `${agent.id} is not configured for subscription-only execution.`, agent.id);
    }
    if (!supportsContinuation(agent)) {
      return failure('continuation_unsupported', `${agent.id} does not provide a native resume command.`, agent.id);
    }

    const readiness = await this.#probe(agent);
    if (readiness.status !== 'available') {
      return failure(readiness.failure_kind ?? readiness.status, readiness.reason, agent.id);
    }
    const result = await this.#runAgent(agent, {
      task,
      cwd: saved.cwd,
      native_session_id: saved.native_session_id,
      timeout_ms: normalizeTimeout(input.timeout_ms, agent.timeout_ms ?? this.config.timeout_ms),
      kind: 'continue',
      effort: saved.effort,
    });
    if (result.status === 'completed') {
      const nativeSessionId = result.native_session_id ?? saved.native_session_id;
      this.sessions[sessionId] = {
        ...saved,
        native_session_id: nativeSessionId,
        updated_at: new Date().toISOString(),
      };
      this.#writeSessions();
      return {
        ...result,
        session_id: sessionId,
        ...(saved.workstream_id ? { workstream_id: saved.workstream_id } : {}),
      };
    }
    return result;
  }

  #selectCandidates(input) {
    let candidates;
    if (input.agent_ids !== undefined) {
      if (!Array.isArray(input.agent_ids) || !input.agent_ids.length || input.agent_ids.some((id) => typeof id !== 'string')) {
        return [];
      }
      const byId = new Map(this.config.agents.map((agent) => [agent.id, agent]));
      candidates = input.agent_ids.map((id) => byId.get(id)).filter(Boolean);
      if (candidates.length !== input.agent_ids.length) return [];
    } else {
      const difficulty = normalizeTaskDifficulty(input.difficulty);
      candidates = this.config.agents
        .filter((agent) => !input.role || agent.roles.includes(input.role))
        .filter((agent) => agentHandlesDifficulty(agent, difficulty))
        .sort((left, right) => left.priority - right.priority);
    }

    return candidates.filter(
      (agent) => agent.enabled,
    );
  }

  async #probe(agent) {
    if (!agent.enabled) {
      const status = { status: 'disabled', reason: 'Disabled in broker configuration.' };
      this.availability.set(agent.id, status);
      return status;
    }
    if (!isSubscriptionAgent(agent)) {
      const status = {
        status: 'unavailable',
        failure_kind: 'policy_rejected',
        reason: 'The agent is not configured for subscription-only execution.',
      };
      this.availability.set(agent.id, status);
      return status;
    }
    if (!agent.probe) {
      const status = {
        status: 'unavailable',
        failure_kind: 'probe_not_configured',
        reason: 'No harmless native probe is configured.',
      };
      this.availability.set(agent.id, status);
      return status;
    }

    const outcome = await runProcess({
      command: agent.command,
      args: agent.probe.args,
      cwd: process.cwd(),
      env: childEnvironment(agent),
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    const parsed = parseOutput(outcome.stdout);
    const status = classifyOutcome(outcome, parsed);
    const availability = status === 'completed'
      ? { status: 'available', reason: undefined }
      : {
          status: 'unavailable',
          failure_kind: status,
          reason: conciseReason(parsed, outcome, status),
        };
    this.availability.set(agent.id, availability);
    return availability;
  }

  async #runAgent(agent, request) {
    if (!isSubscriptionAgent(agent)) {
      return failure('policy_rejected', `${agent.id} is not configured for subscription-only execution.`, agent.id);
    }
    const running = this.active.get(agent.id) ?? 0;
    if (running >= agent.max_concurrency) {
      return failure('busy', `${agent.id} is at its concurrency limit.`, agent.id);
    }

    this.active.set(agent.id, running + 1);
    const startedAt = new Date().toISOString();
    try {
      const adapter = await this.#adapterFor(agent);
      const outcome = await adapter.invoke({
        ...request,
        agent,
        model: request.model ?? modelForDifficulty(agent, request.difficulty),
      });
      const parsed = outcome.parsed ?? parseOutput(outcome.stdout);
      const status = outcome.status ?? classifyOutcome(outcome, parsed);
      const nativeSessionId = outcome.native_session_id ?? parsed.native_session_id;
      const result = {
        status,
        agent_id: agent.id,
        summary: outcome.summary ?? conciseReason(parsed, outcome, status),
        ...(request.workstream_id ? { workstream_id: request.workstream_id } : {}),
        ...(nativeSessionId ? { native_session_id: nativeSessionId } : {}),
      };
      const logPath = this.#writeLog({ agent, request, outcome, result, startedAt });
      result.log_path = logPath;

      if (status === 'completed' && request.kind === 'delegate' && nativeSessionId) {
        const sessionId = `broker-${randomUUID()}`;
        this.sessions[sessionId] = {
          agent_id: agent.id,
          adapter: agent.adapter,
          adapter_identity: adapterIdentity(agent),
          native_session_id: nativeSessionId,
          cwd: request.cwd,
          effort: request.effort,
          workstream_id: request.workstream_id,
          created_at: startedAt,
          updated_at: new Date().toISOString(),
        };
        this.workstreams.set(request.workstream_id, sessionId);
        this.#writeSessions();
        result.session_id = sessionId;
      }
      return result;
    } catch (error) {
      return failure('adapter_error', error instanceof Error ? error.message : String(error), agent.id);
    } finally {
      const remaining = (this.active.get(agent.id) ?? 1) - 1;
      if (remaining > 0) this.active.set(agent.id, remaining);
      else this.active.delete(agent.id);
    }
  }

  async #adapterFor(agent) {
    const cacheKey = agent.adapter_module ?? agent.adapter;
    if (this.adapters.has(cacheKey)) return this.adapters.get(cacheKey);

    let adapter;
    if (agent.adapter_module) {
      const module = await import(pathToFileURL(agent.adapter_module).href);
      if (typeof module.createAdapter !== 'function') {
        throw new TypeError(`Adapter module ${agent.adapter_module} must export createAdapter.`);
      }
      adapter = await module.createAdapter({ runProcess, parseOutput, childEnvironment, interpolateArguments });
    } else if (agent.adapter === 'native-cli') {
      adapter = nativeCliAdapter;
    } else if (agent.adapter === 'codex-exec') {
      adapter = codexExecAdapter;
    } else {
      throw new TypeError(`No adapter registered for ${agent.adapter}.`);
    }
    if (!adapter || typeof adapter.invoke !== 'function') {
      throw new TypeError(`Adapter ${agent.adapter} must provide invoke(request).`);
    }
    this.adapters.set(cacheKey, adapter);
    return adapter;
  }

  #readSessions() {
    try {
      const state = JSON.parse(readFileSync(this.sessionFile, 'utf8'));
      return state && typeof state.sessions === 'object' && !Array.isArray(state.sessions)
        ? state.sessions
        : {};
    } catch (error) {
      if (error?.code === 'ENOENT') return {};
      throw new TypeError(`Could not read broker session state: ${error.message}`);
    }
  }

  #writeSessions() {
    const temporary = `${this.sessionFile}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ version: 1, sessions: this.sessions }, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.sessionFile);
  }

  #writeLog({ agent, request, outcome, result, startedAt }) {
    const filename = `${Date.now()}-${randomUUID()}.json`;
    const path = join(this.logDir, filename);
    writeFileSync(path, `${JSON.stringify({
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      agent_id: agent.id,
      kind: request.kind,
      workstream_id: request.workstream_id,
      cwd: request.cwd,
      result,
      process: {
        exit_code: outcome.code ?? null,
        signal: outcome.signal ?? null,
        timed_out: Boolean(outcome.timedOut),
        error: outcome.error?.message,
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        truncated: Boolean(outcome.truncated),
      },
    }, null, 2)}\n`, { mode: 0o600 });
    return path;
  }
}

const nativeCliAdapter = {
  async invoke(request) {
    const { agent, task, cwd, native_session_id: nativeSessionId, timeout_ms: timeoutMs, kind } = request;
    const template = kind === 'continue' ? agent.resume_args : agent.args;
    if (kind === 'continue' && !template) {
      return { status: 'continuation_unsupported', summary: `${agent.id} has no resume_args.` };
    }
    const args = withModelFlag(
      interpolateArguments(template, { prompt: task, session_id: nativeSessionId, cwd }),
      request.model,
    );
    return runProcess({
      command: agent.command,
      args,
      cwd,
      env: childEnvironment(agent),
      timeoutMs,
    });
  },
};

const codexExecAdapter = {
  async invoke(request) {
    const { agent, task, cwd, native_session_id: nativeSessionId, timeout_ms: timeoutMs, kind } = request;
    const args = kind === 'continue'
      ? ['exec', '--ignore-user-config', 'resume', nativeSessionId, '--json']
      : ['exec', '--ignore-user-config', '--json', '--cd', cwd];
    const model = request.model ?? agent.model;
    if (model) args.push('--model', model);
    if (request.effort) args.push('--config', `model_reasoning_effort="${request.effort}"`);
    if (kind === 'delegate' && agent.sandbox) args.push('--sandbox', agent.sandbox);
    args.push('--', task);
    return runProcess({
      command: agent.command,
      args,
      cwd,
      env: childEnvironment(agent),
      timeoutMs,
    });
  },
};

function interpolateArguments(template, values) {
  return template.map((argument) => {
    if (argument === '{{prompt}}') return values.prompt;
    if (argument === '{{session_id}}') return values.session_id;
    if (argument === '{{cwd}}') return values.cwd;
    return argument;
  });
}

function childEnvironment(agent) {
  const environment = { ...process.env, ...agent.env };
  for (const name of Object.keys(environment)) {
    if (API_KEY_NAME.test(name)) delete environment[name];
  }
  environment[BROKER_DEPTH_NAME] = String(delegationDepth(process.env) + 1);
  return environment;
}

function delegationDepth(environment) {
  const value = Number.parseInt(environment[BROKER_DEPTH_NAME] ?? '0', 10);
  return Number.isInteger(value) && value > 0 ? value : 0;
}

function runProcess({ command, args, cwd, env, timeoutMs }) {
  return new Promise((resolveOutcome) => {
    let child;
    let settled = false;
    let timedOut = false;
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timeout;
    let killTimer;

    const append = (current, chunk) => {
      if (current.length >= MAX_CAPTURE_BYTES) {
        truncated = true;
        return current;
      }
      const available = MAX_CAPTURE_BYTES - current.length;
      const text = chunk.toString();
      if (text.length > available) truncated = true;
      return current + text.slice(0, available);
    };
    const finish = (extra = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(killTimer);
      resolveOutcome({ stdout, stderr, timedOut, truncated, ...extra });
    };

    try {
      child = spawn(command, args, {
        cwd,
        env,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      finish({ error });
      return;
    }

    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    child.on('error', (error) => finish({ error }));
    child.on('close', (code, signal) => finish({ code, signal }));
    timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 1_000);
      killTimer.unref?.();
    }, timeoutMs);
    timeout.unref?.();
  });
}

function parseOutput(stdout = '') {
  let lastPayload;
  let nativeSessionId;
  let summary;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const payload = JSON.parse(line);
      if (!payload || typeof payload !== 'object') continue;
      lastPayload = payload;
      nativeSessionId ??= nativeSessionIdFrom(payload);
      summary = summaryFromPayload(payload) ?? summary;
    } catch {
      // Native CLIs are allowed to return plain text; the bounded text becomes the summary.
    }
  }
  return { payload: lastPayload, native_session_id: nativeSessionId, summary };
}

function summaryFromPayload(payload) {
  const direct = [payload.summary, payload.message, payload.response, payload.text]
    .find((value) => typeof value === 'string' && value.trim());
  if (direct) return direct;
  if (payload.type === 'item.completed' && payload.item?.type === 'agent_message') {
    return typeof payload.item.text === 'string' && payload.item.text.trim()
      ? payload.item.text
      : undefined;
  }
  return undefined;
}

function nativeSessionIdFrom(payload) {
  for (const key of ['session_id', 'sessionId', 'thread_id', 'threadId', 'conversation_id', 'conversationId']) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function classifyOutcome(outcome, parsed) {
  if (outcome.timedOut) return 'timeout';
  if (outcome.error?.code === 'ENOENT') return 'unavailable';
  if (outcome.error) return 'failed';

  const explicit = typeof parsed.payload?.status === 'string'
    ? parsed.payload.status.toLowerCase()
    : undefined;
  if (explicit === 'available') return 'completed';
  if (['auth_required', 'auth_failed', 'login_required', 'unauthorized'].includes(explicit)) {
    return 'authentication_failed';
  }
  if (['completed', 'quota_exhausted', 'unavailable', 'invalid_request', 'authentication_failed', 'timeout', 'failed'].includes(explicit)) {
    return explicit;
  }

  const detail = `${outcome.stdout}\n${outcome.stderr}`.toLowerCase();
  if (/quota|rate limit|usage limit|too many requests/.test(detail)) return 'quota_exhausted';
  if (/not logged in|login required|authentication|auth (?:required|failed)|unauthori[sz]ed|expired token/.test(detail)) return 'authentication_failed';
  if (outcome.code === 0) return 'completed';
  return 'failed';
}

function conciseReason(parsed, outcome, status) {
  const candidates = [
    parsed.summary,
    parsed.payload?.summary,
    parsed.payload?.message,
    parsed.payload?.response,
    parsed.payload?.text,
    ...(status === 'completed'
      ? [outcome.stdout, outcome.stderr]
      : [outcome.stderr, outcome.stdout]),
    outcome.error?.message,
  ];
  const candidate = candidates.find((value) => typeof value === 'string' && value.trim());
  return candidate ? candidate.replace(/\s+/g, ' ').trim().slice(0, 6_000) : `${status}.`;
}

function validateTask(task) {
  if (typeof task !== 'string' || !task.trim()) {
    throw new TypeError('delegate and continue require a non-empty task.');
  }
  return task;
}

function normalizeCwd(cwd) {
  if (cwd === undefined) return process.cwd();
  if (typeof cwd !== 'string' || !cwd) throw new TypeError('cwd must be a non-empty path.');
  return resolve(cwd);
}

function normalizeWorkstreamId(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function workstreamIndex(sessions) {
  const index = new Map();
  const records = Object.entries(sessions).sort(([leftId, left], [rightId, right]) => {
    const leftTime = Date.parse(left?.updated_at ?? left?.created_at ?? '') || 0;
    const rightTime = Date.parse(right?.updated_at ?? right?.created_at ?? '') || 0;
    return leftTime - rightTime || leftId.localeCompare(rightId);
  });
  for (const [sessionId, session] of records) {
    const workstreamId = normalizeWorkstreamId(session?.workstream_id);
    if (workstreamId) index.set(workstreamId, sessionId);
  }
  return index;
}

function supportsContinuation(agent) {
  return Boolean(agent.resume_args || agent.adapter === 'codex-exec' || agent.continuation);
}

function isSubscriptionAgent(agent) {
  return agent.billing?.mode === 'subscription' && agent.billing?.fallback === 'forbidden';
}

function adapterIdentity(agent) {
  return `${agent.adapter}:${agent.adapter_module ?? ''}`;
}

function failure(status, summary, agentId) {
  return { status, ...(agentId ? { agent_id: agentId } : {}), summary };
}

export const internals = {
  childEnvironment,
  classifyOutcome,
  conciseReason,
  interpolateArguments,
  parseOutput,
  runProcess,
};
