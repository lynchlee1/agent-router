import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(testDirectory, 'fixtures', 'fake-native-cli');
const sourcePath = join(testDirectory, '..', 'src', 'index.js');
const binPath = join(testDirectory, '..', 'bin', 'agent-broker.js');
const sourceReady = existsSync(sourcePath);
const mcpSurfaceReady = sourceReady && existsSync(binPath);
const brokerApi = sourceReady
  ? await import(pathToFileURL(sourcePath).href)
  : null;
const { loadConfig, AgentBroker, internals } = brokerApi ?? {};

function contractTest(name, fn) {
  return test(
    name,
    {
      concurrency: false,
      skip: sourceReady ? false : 'src/index.js has not landed yet',
    },
    fn,
  );
}

function mcpTest(name, fn) {
  return test(
    name,
    {
      concurrency: false,
      skip: mcpSurfaceReady
        ? false
        : 'src/index.js or bin/agent-broker.js has not landed yet',
    },
    fn,
  );
}

async function makeSandbox(t) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-broker-test-'));
  const stateDir = join(directory, 'state');
  const logPath = join(directory, 'fake-cli.jsonl');
  await mkdir(stateDir);
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, stateDir, logPath };
}

function fakeAgent({
  id,
  logPath,
  mode = 'complete',
  probeMode = 'available',
  enabled = true,
  priority = 10,
  maxConcurrency = 1,
  delayMs,
  nativeSessionId,
  resume = false,
} = {}) {
  const optionArgs = [
    '--label',
    id,
    '--log',
    logPath,
  ];
  const delayArgs = delayMs ? ['--delay-ms', String(delayMs)] : [];
  const sessionArgs = nativeSessionId ? ['--session-id', nativeSessionId] : [];

  return {
    id,
    adapter: 'native-cli',
    enabled,
    billing: { mode: 'subscription', fallback: 'forbidden' },
    roles: ['implementation'],
    scarcity: 'normal',
    priority,
    max_concurrency: maxConcurrency,
    command: process.execPath,
    probe: {
      args: [
        fixturePath,
        '--probe',
        '--mode',
        probeMode,
        ...optionArgs,
      ],
    },
    args: [
      fixturePath,
      '--mode',
      mode,
      ...optionArgs,
      ...delayArgs,
      ...sessionArgs,
      '--prompt',
      '{{prompt}}',
      '--cwd',
      '{{cwd}}',
    ],
    ...(resume
      ? {
          resume_args: [
            fixturePath,
            '--mode',
            'complete',
            ...optionArgs,
            ...delayArgs,
            '--resume',
            '{{session_id}}',
            '--prompt',
            '{{prompt}}',
            '--cwd',
            '{{cwd}}',
          ],
        }
      : {}),
  };
}

function configFor(sandbox, agents) {
  return { agents, state_dir: sandbox.stateDir };
}

async function events(logPath) {
  try {
    const content = await readFile(logPath, 'utf8');
    return content
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function waitForEvent(logPath, predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = (await events(logPath)).find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for fake CLI event in ${logPath}`);
}

contractTest('parseOutput maps native session ids from common JSON field names', () => {
  assert.equal(internals.parseOutput('{"conversation_id":"conv-1"}').native_session_id, 'conv-1');
  assert.equal(internals.parseOutput('{"sessionId":"sess-1"}').native_session_id, 'sess-1');
  assert.equal(internals.parseOutput('{"thread_id":"thread-1"}').native_session_id, 'thread-1');
  assert.equal(internals.parseOutput('{"session_id":"native-1"}').native_session_id, 'native-1');
  assert.equal(internals.parseOutput('not json\n{"conversationId":"conv-2"}').native_session_id, 'conv-2');
});

contractTest('conciseReason prefers response and text over raw stdout JSON', () => {
  const fromResponse = internals.parseOutput('{"conversation_id":"conv-1","status":"SUCCESS","response":"ok\\n"}');
  assert.equal(internals.conciseReason(fromResponse, { stdout: '{"response":"ok"}' }, 'completed'), 'ok');

  const fromText = internals.parseOutput('{"sessionId":"sess-1","text":"pong"}');
  assert.equal(internals.conciseReason(fromText, { stdout: '{"text":"pong"}' }, 'completed'), 'pong');
});

contractTest('Codex JSONL agent messages outrank nonfatal stderr warnings', () => {
  const stdout = [
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
    JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: 'repository review complete' },
    }),
    JSON.stringify({ type: 'turn.completed', usage: { output_tokens: 4 } }),
  ].join('\n');
  const parsed = internals.parseOutput(stdout);

  assert.equal(parsed.native_session_id, 'thread-1');
  assert.equal(
    internals.conciseReason(
      parsed,
      { stdout, stderr: 'failed to load models cache: stale schema' },
      'completed',
    ),
    'repository review complete',
  );
});

contractTest('completed plain-text stdout outranks nonfatal stderr warnings', () => {
  const parsed = internals.parseOutput('plain-text result');
  assert.equal(
    internals.conciseReason(
      parsed,
      { stdout: 'plain-text result', stderr: 'nonfatal warning' },
      'completed',
    ),
    'plain-text result',
  );
});

contractTest('loadConfig accepts only subscription agents with forbidden fallback', async (t) => {
  const sandbox = await makeSandbox(t);
  const validConfigPath = join(sandbox.directory, 'valid.json');
  const apiKeyConfigPath = join(sandbox.directory, 'api-key.json');
  const fallbackConfigPath = join(sandbox.directory, 'fallback.json');
  const validAgent = fakeAgent({ id: 'valid', logPath: sandbox.logPath });

  await writeFile(
    validConfigPath,
    JSON.stringify(configFor(sandbox, [validAgent])),
  );
  await writeFile(
    apiKeyConfigPath,
    JSON.stringify(
      configFor(sandbox, [
        {
          ...validAgent,
          billing: { mode: 'api_key', fallback: 'forbidden' },
        },
      ]),
    ),
  );
  await writeFile(
    fallbackConfigPath,
    JSON.stringify(
      configFor(sandbox, [
        {
          ...validAgent,
          billing: { mode: 'subscription', fallback: 'allowed' },
        },
      ]),
    ),
  );

  const config = loadConfig(validConfigPath);
  assert.equal(config.agents[0].billing.mode, 'subscription');
  assert.equal(config.agents[0].billing.fallback, 'forbidden');
  assert.throws(() => loadConfig(apiKeyConfigPath), /subscription|billing/i);
  assert.throws(() => loadConfig(fallbackConfigPath), /forbidden|fallback|billing/i);
});

contractTest('loadConfig rejects resume arguments without a whole session-id placeholder', async (t) => {
  const sandbox = await makeSandbox(t);
  const configPath = join(sandbox.directory, 'invalid-resume.json');
  const agent = fakeAgent({ id: 'invalid-resume', logPath: sandbox.logPath, resume: true });
  agent.resume_args = agent.resume_args.map((argument) => (
    argument === '{{session_id}}' ? '--resume={{session_id}}' : argument
  ));

  await writeFile(configPath, JSON.stringify(configFor(sandbox, [agent])));

  assert.throws(() => loadConfig(configPath), /resume_args|session_id/i);
});

contractTest('loadConfig accepts difficulty only on routes', async (t) => {
  const sandbox = await makeSandbox(t);
  const agent = fakeAgent({ id: 'worker', logPath: sandbox.logPath });

  assert.throws(
    () => loadConfig(configFor(sandbox, [{ ...agent, difficulty: 'hard_task' }])),
    /difficulty must be configured on routes/i,
  );
  assert.throws(
    () => loadConfig(configFor(sandbox, [{
      ...agent,
      routes: [{ difficulty: 'high', model: 'strong' }],
    }])),
    /route difficulty must be one of/i,
  );
});

contractTest('discovery probes enabled agents and reports unavailable and disabled states', async (t) => {
  const sandbox = await makeSandbox(t);
  const broker = new AgentBroker(
    configFor(sandbox, [
      fakeAgent({ id: 'ready', logPath: sandbox.logPath }),
      fakeAgent({
        id: 'offline',
        logPath: sandbox.logPath,
        probeMode: 'unavailable',
      }),
      fakeAgent({ id: 'disabled', logPath: sandbox.logPath, enabled: false }),
    ]),
  );

  const result = await broker.listAgents({ refresh: true });
  const statusById = Object.fromEntries(
    result.agents.map((agent) => [agent.id, agent.status]),
  );

  assert.deepEqual(statusById, {
    ready: 'available',
    offline: 'unavailable',
    disabled: 'disabled',
  });
  assert.equal(result.agents.find((agent) => agent.id === 'ready').billing.mode, 'subscription');
  assert.deepEqual(result.agents.find((agent) => agent.id === 'ready').roles, ['implementation']);

  const probes = (await events(sandbox.logPath)).filter(
    (event) => event.kind === 'probe',
  );
  assert.deepEqual(
    probes.map((event) => event.label).sort(),
    ['offline', 'ready'],
  );
});

contractTest('delegate injects the route model for a difficulty', async (t) => {
  const sandbox = await makeSandbox(t);
  const broker = new AgentBroker(
    configFor(sandbox, [
      {
        ...fakeAgent({ id: 'multi', logPath: sandbox.logPath }),
        routes: [
          { difficulty: 'easy_task', model: 'fast' },
          { difficulty: 'hard_task', model: 'strong' },
        ],
      },
    ]),
  );

  const result = await broker.delegate({
    task: 'hard work',
    cwd: sandbox.directory,
    difficulty: 'hard_task',
  });
  assert.equal(result.status, 'completed');
  const run = (await events(sandbox.logPath)).find((event) => event.kind === 'run');
  assert.equal(run.argv[run.argv.indexOf('--model') + 1], 'strong');
});

contractTest('delegate defaults omitted difficulty to the standard task route', async (t) => {
  const sandbox = await makeSandbox(t);
  const broker = new AgentBroker(
    configFor(sandbox, [
      {
        ...fakeAgent({ id: 'multi', logPath: sandbox.logPath }),
        routes: [
          { difficulty: 'easy_task', model: 'fast' },
          { difficulty: 'standard_task', model: 'balanced' },
        ],
      },
    ]),
  );

  const result = await broker.delegate({
    task: 'routine work',
    cwd: sandbox.directory,
  });

  assert.equal(result.status, 'completed');
  const run = (await events(sandbox.logPath)).find((event) => event.kind === 'run');
  assert.equal(run.argv[run.argv.indexOf('--model') + 1], 'balanced');
});

contractTest('delegate uses a default model when no route matches', async (t) => {
  const sandbox = await makeSandbox(t);
  const broker = new AgentBroker(
    configFor(sandbox, [
      {
        ...fakeAgent({ id: 'default-model', logPath: sandbox.logPath }),
        model: 'default',
        routes: [{ difficulty: 'easy_task', model: 'fast' }],
      },
    ]),
  );

  const result = await broker.delegate({
    task: 'hard work',
    cwd: sandbox.directory,
    difficulty: 'hard_task',
  });
  assert.equal(result.status, 'completed');
  const run = (await events(sandbox.logPath)).find((event) => event.kind === 'run');
  assert.equal(run.argv[run.argv.indexOf('--model') + 1], 'default');
});

contractTest('delegate with difficulty only uses matching workers', async (t) => {
  const sandbox = await makeSandbox(t);
  const broker = new AgentBroker(
    configFor(sandbox, [
      {
        ...fakeAgent({ id: 'easy', logPath: sandbox.logPath }),
        routes: [{ difficulty: 'easy_task', model: 'fast' }],
      },
      {
        ...fakeAgent({ id: 'hard', logPath: sandbox.logPath }),
        routes: [{ difficulty: 'hard_task', model: 'strong' }],
      },
    ]),
  );

  const result = await broker.delegate({
    task: 'hard work',
    cwd: sandbox.directory,
    difficulty: 'hard_task',
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.agent_id, 'hard');
});

contractTest('codex-exec isolates user config and marks the worker as a delegation leaf', async (t) => {
  const sandbox = await makeSandbox(t);
  const codexCommand = join(sandbox.directory, 'codex');
  await writeFile(
    codexCommand,
    `#!/usr/bin/env node\nimport ${JSON.stringify(pathToFileURL(fixturePath).href)};\n`,
  );
  await chmod(codexCommand, 0o755);
  const broker = new AgentBroker(
    configFor(sandbox, [{
      id: 'codex-leaf',
      adapter: 'codex-exec',
      enabled: true,
      billing: { mode: 'subscription', fallback: 'forbidden' },
      roles: ['review'],
      command: codexCommand,
      env: { FAKE_CLI_LOG: sandbox.logPath },
      probe: { args: ['--probe'] },
      routes: [{ difficulty: 'hard_task', model: 'strong', effort: 'high' }],
    }]),
  );

  const result = await broker.delegate({
    task: 'review the design',
    cwd: sandbox.directory,
    difficulty: 'hard_task',
  });

  assert.equal(result.status, 'completed');
  const run = (await events(sandbox.logPath)).find((event) => event.kind === 'run');
  assert.deepEqual(run.argv, [
    'exec',
    '--ignore-user-config',
    '--json',
    '--cd',
    sandbox.directory,
    '--model',
    'strong',
    '--config',
    'model_reasoning_effort="high"',
    '--',
    'review the design',
  ]);
  assert.equal(run.environment.AGENT_BROKER_DEPTH, '1');
});

contractTest('a broker started inside a worker rejects recursive delegation', async (t) => {
  const sandbox = await makeSandbox(t);
  const originalDepth = process.env.AGENT_BROKER_DEPTH;
  process.env.AGENT_BROKER_DEPTH = '1';
  let broker;
  try {
    broker = new AgentBroker(
      configFor(sandbox, [fakeAgent({ id: 'nested', logPath: sandbox.logPath })]),
    );
  } finally {
    restoreEnv('AGENT_BROKER_DEPTH', originalDepth);
  }

  const result = await broker.delegate({
    task: 'do not delegate again',
    cwd: sandbox.directory,
  });

  assert.equal(result.status, 'policy_rejected');
  assert.match(result.summary, /recursive delegation/i);
  assert.deepEqual(await events(sandbox.logPath), []);
});

contractTest('retry-safe work falls back from quota exhaustion to the next priority candidate', async (t) => {
  const sandbox = await makeSandbox(t);
  const broker = new AgentBroker(
    configFor(sandbox, [
      fakeAgent({
        id: 'priority-quota',
        logPath: sandbox.logPath,
        mode: 'quota',
        priority: 10,
      }),
      fakeAgent({
        id: 'priority-backup',
        logPath: sandbox.logPath,
        priority: 20,
      }),
    ]),
  );

  const result = await broker.delegate({
    task: 'safe retry task',
    cwd: sandbox.directory,
    agent_ids: ['priority-quota', 'priority-backup'],
    retry_safe: true,
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.agent_id, 'priority-backup');
  const runs = (await events(sandbox.logPath)).filter(
    (event) => event.kind === 'run',
  );
  assert.deepEqual(
    runs.map((event) => event.label),
    ['priority-quota', 'priority-backup'],
  );
});

contractTest('quota exhaustion never falls back when the work is not retry-safe', async (t) => {
  const sandbox = await makeSandbox(t);
  const broker = new AgentBroker(
    configFor(sandbox, [
      fakeAgent({
        id: 'quota-only',
        logPath: sandbox.logPath,
        mode: 'quota',
        priority: 10,
      }),
      fakeAgent({ id: 'must-not-run', logPath: sandbox.logPath, priority: 20 }),
    ]),
  );

  const result = await broker.delegate({
    task: 'non-idempotent task',
    cwd: sandbox.directory,
    agent_ids: ['quota-only', 'must-not-run'],
    retry_safe: false,
  });

  assert.equal(result.status, 'quota_exhausted');
  assert.equal(result.agent_id, 'quota-only');
  const runs = (await events(sandbox.logPath)).filter(
    (event) => event.kind === 'run',
  );
  assert.deepEqual(runs.map((event) => event.label), ['quota-only']);
});

contractTest('a plain-text (non-JSON) stdout becomes the summary instead of a generic status string', async (t) => {
  const sandbox = await makeSandbox(t);
  const broker = new AgentBroker(
    configFor(sandbox, [
      fakeAgent({ id: 'plain-text-agent', logPath: sandbox.logPath, mode: 'plaintext' }),
    ]),
  );

  const result = await broker.delegate({
    task: 'summarize the repo',
    cwd: sandbox.directory,
    agent_ids: ['plain-text-agent'],
  });

  assert.equal(result.status, 'completed');
  assert.match(result.summary, /plain-text report: summarize the repo/);
});

contractTest('a failed authentication preflight never sends the task and may safely try a later candidate', async (t) => {
  const sandbox = await makeSandbox(t);
  const broker = new AgentBroker(
    configFor(sandbox, [
      fakeAgent({
        id: 'needs-login',
        logPath: sandbox.logPath,
        probeMode: 'authentication_failed',
        priority: 10,
      }),
      fakeAgent({ id: 'preflight-backup', logPath: sandbox.logPath, priority: 20 }),
    ]),
  );

  const result = await broker.delegate({
    task: 'do not send this to an unauthenticated CLI',
    cwd: sandbox.directory,
    agent_ids: ['needs-login', 'preflight-backup'],
    retry_safe: false,
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.agent_id, 'preflight-backup');
  const invocations = await events(sandbox.logPath);
  assert.ok(
    invocations.some(
      (event) => event.kind === 'probe' && event.label === 'needs-login',
    ),
  );
  assert.equal(
    invocations.some(
      (event) => event.kind === 'run' && event.label === 'needs-login',
    ),
    false,
  );
});

contractTest('dispatch rejects a mutated non-subscription agent before spawning its probe or task', async (t) => {
  const sandbox = await makeSandbox(t);
  const broker = new AgentBroker(
    configFor(sandbox, [
      fakeAgent({ id: 'policy-guard', logPath: sandbox.logPath }),
    ]),
  );
  broker.config.agents[0].billing = {
    mode: 'api_key',
    fallback: 'forbidden',
  };

  const result = await broker.delegate({
    task: 'this must never reach a CLI',
    cwd: sandbox.directory,
    agent_ids: ['policy-guard'],
  });

  assert.equal(result.status, 'policy_rejected');
  assert.deepEqual(await events(sandbox.logPath), []);
});

contractTest('an agent at its concurrency limit is reported as busy without another spawn', async (t) => {
  const sandbox = await makeSandbox(t);
  const broker = new AgentBroker(
    configFor(sandbox, [
      fakeAgent({
        id: 'single-flight',
        logPath: sandbox.logPath,
        delayMs: 150,
        maxConcurrency: 1,
      }),
    ]),
  );

  const first = broker.delegate({
    task: 'long task',
    cwd: sandbox.directory,
    agent_ids: ['single-flight'],
  });
  await waitForEvent(
    sandbox.logPath,
    (event) => event.kind === 'run' && event.label === 'single-flight',
  );
  const second = await broker.delegate({
    task: 'overlapping task',
    cwd: sandbox.directory,
    agent_ids: ['single-flight'],
  });
  const firstResult = await first;

  assert.equal(second.status, 'busy');
  assert.equal(second.agent_id, 'single-flight');
  assert.equal(firstResult.status, 'completed');
  const runs = (await events(sandbox.logPath)).filter(
    (event) => event.kind === 'run',
  );
  assert.equal(runs.length, 1);
});

contractTest('a native CLI session is mapped and continued through its configured resume command', async (t) => {
  const sandbox = await makeSandbox(t);
  const broker = new AgentBroker(
    configFor(sandbox, [
      fakeAgent({
        id: 'session-agent',
        logPath: sandbox.logPath,
        nativeSessionId: 'native-1',
        resume: true,
      }),
    ]),
  );

  const initial = await broker.delegate({
    task: 'start a native session',
    cwd: sandbox.directory,
    agent_ids: ['session-agent'],
  });
  assert.equal(initial.status, 'completed');
  assert.equal(initial.agent_id, 'session-agent');
  assert.ok(initial.session_id);
  assert.notEqual(initial.session_id, 'native-1');

  const continuation = await broker.continue({
    session_id: initial.session_id,
    task: 'follow-up request',
    timeout_ms: 500,
  });
  assert.equal(continuation.status, 'completed');
  assert.equal(continuation.agent_id, 'session-agent');
  assert.equal(continuation.session_id, initial.session_id);
  assert.match(continuation.summary, /follow-up request/);

  const resume = await waitForEvent(
    sandbox.logPath,
    (event) => event.kind === 'resume' && event.label === 'session-agent',
  );
  assert.equal(resume.resume_session_id, 'native-1');
  assert.equal(resume.prompt, 'follow-up request');
});

contractTest('a persisted session refuses continuation when its agent adapter changes', async (t) => {
  const sandbox = await makeSandbox(t);
  const originalAgent = fakeAgent({
    id: 'stable-agent',
    logPath: sandbox.logPath,
    nativeSessionId: 'native-session',
    resume: true,
  });
  const initialBroker = new AgentBroker(configFor(sandbox, [originalAgent]));
  const initial = await initialBroker.delegate({
    task: 'create a durable session',
    cwd: sandbox.directory,
    agent_ids: ['stable-agent'],
  });
  assert.equal(initial.status, 'completed');
  assert.ok(initial.session_id);

  const eventsBefore = await events(sandbox.logPath);
  const logsDirectory = join(sandbox.stateDir, 'logs');
  const logsBefore = (await readdir(logsDirectory)).sort();
  const changedAgent = {
    ...fakeAgent({
      id: 'stable-agent',
      logPath: sandbox.logPath,
      nativeSessionId: 'native-session',
      resume: true,
    }),
    adapter: 'codex-exec',
  };
  const restartedBroker = new AgentBroker(configFor(sandbox, [changedAgent]));

  const result = await restartedBroker.continue({
    session_id: initial.session_id,
    task: 'do not launch this continuation',
  });

  assert.equal(result.status, 'session_adapter_changed');
  assert.equal(result.agent_id, 'stable-agent');
  assert.deepEqual(await events(sandbox.logPath), eventsBefore);
  assert.deepEqual((await readdir(logsDirectory)).sort(), logsBefore);
});

contractTest('a per-call timeout terminates the native CLI and reports timeout', async (t) => {
  const sandbox = await makeSandbox(t);
  const broker = new AgentBroker(
    configFor(sandbox, [
      fakeAgent({
        id: 'slow-agent',
        logPath: sandbox.logPath,
        delayMs: 500,
      }),
    ]),
  );

  const result = await broker.delegate({
    task: 'must time out',
    cwd: sandbox.directory,
    agent_ids: ['slow-agent'],
    timeout_ms: 30,
  });

  assert.equal(result.status, 'timeout');
  assert.equal(result.agent_id, 'slow-agent');
});

contractTest('native subprocesses do not receive inherited API-key environment variables', async (t) => {
  const sandbox = await makeSandbox(t);
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
  const originalGeminiKey = process.env.GEMINI_API_KEY;
  const originalCodexKey = process.env.CODEX_API_KEY;
  const originalFutureProviderKey = process.env.FUTURE_PROVIDER_API_KEY;
  const originalCodexHome = process.env.CODEX_HOME;
  process.env.OPENAI_API_KEY = 'must-not-reach-fake-cli';
  process.env.ANTHROPIC_API_KEY = 'must-not-reach-fake-cli';
  process.env.GEMINI_API_KEY = 'must-not-reach-fake-cli';
  process.env.CODEX_API_KEY = 'must-not-reach-fake-cli';
  process.env.FUTURE_PROVIDER_API_KEY = 'must-not-reach-fake-cli';
  process.env.CODEX_HOME = 'must-reach-fake-cli';

  try {
    const broker = new AgentBroker(
      configFor(sandbox, [
        fakeAgent({ id: 'sanitized', logPath: sandbox.logPath }),
      ]),
    );
    const result = await broker.delegate({
      task: 'verify child environment',
      cwd: sandbox.directory,
      agent_ids: ['sanitized'],
    });
    assert.equal(result.status, 'completed');
  } finally {
    restoreEnv('OPENAI_API_KEY', originalOpenAiKey);
    restoreEnv('ANTHROPIC_API_KEY', originalAnthropicKey);
    restoreEnv('GEMINI_API_KEY', originalGeminiKey);
    restoreEnv('CODEX_API_KEY', originalCodexKey);
    restoreEnv('FUTURE_PROVIDER_API_KEY', originalFutureProviderKey);
    restoreEnv('CODEX_HOME', originalCodexHome);
  }

  await waitForEvent(
    sandbox.logPath,
    (event) => event.kind === 'run' && event.label === 'sanitized',
  );
  const childInvocations = (await events(sandbox.logPath)).filter(
    (event) => event.label === 'sanitized',
  );
  for (const invocation of childInvocations) {
    assert.deepEqual(invocation.environment, {
      OPENAI_API_KEY: null,
      ANTHROPIC_API_KEY: null,
      GEMINI_API_KEY: null,
      CODEX_API_KEY: null,
      FUTURE_PROVIDER_API_KEY: null,
      CODEX_HOME: 'must-reach-fake-cli',
      AGENT_BROKER_DEPTH: '1',
    });
  }
});

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

mcpTest('the stdio MCP server exposes and serves the list_agents tool', async (t) => {
  const sandbox = await makeSandbox(t);
  const configPath = join(sandbox.directory, 'agent-broker.json');
  await writeFile(
    configPath,
    JSON.stringify(
      configFor(sandbox, [
        fakeAgent({ id: 'mcp-ready', logPath: sandbox.logPath }),
      ]),
    ),
  );

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [binPath, '--config', configPath],
    cwd: sandbox.directory,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'agent-broker-contract-test', version: '1.0.0' });
  t.after(async () => {
    await client.close();
  });

  await client.connect(transport);
  const listed = await client.listTools();
  assert.ok(listed.tools.some((tool) => tool.name === 'list_agents'));

  const result = await client.callTool({
    name: 'list_agents',
    arguments: { refresh: true },
  });
  assert.notEqual(result.isError, true);
  assert.match(JSON.stringify(result), /mcp-ready/);
  assert.match(JSON.stringify(result), /available/);
});
