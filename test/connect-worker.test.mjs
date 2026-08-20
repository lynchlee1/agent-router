import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(
  testDirectory,
  '..',
  'bin',
  'connect-worker.js',
);
const fixturePath = join(testDirectory, 'fixtures', 'fake-native-cli');
const connect = await import(pathToFileURL(scriptPath).href);

test('slashCompletions filters commands and arguments', () => {
  const commands = [
    {
      name: 'add',
      hint: '<service> <model> <effort>',
      complete: (insert) => Boolean(connect.parseWorkerRouteInput(connect.parseSlashCommand(insert)?.argument)),
    },
    { name: 'delete', hint: '<service> <model> <effort>', arguments: () => ['gpt-x'] },
  ];
  assert.deepEqual(
    connect.slashCompletions('/', commands).map((item) => item.title),
    ['/add    <service> <model> <effort>', '/delete <service> <model> <effort>'],
  );
  assert.deepEqual(
    connect.slashCompletions('/ad', commands).map((item) => item.insert),
    ['/add '],
  );
  assert.deepEqual(
    connect.slashCompletions('/add g', commands).map((item) => item.title),
    [],
  );
  assert.deepEqual(
    connect.slashCompletions('/add gpt-x h', commands).map((item) => item.insert),
    [],
  );
});

test('parseSlashCommand maps /add and /delete', () => {
  assert.deepEqual(connect.parseSlashCommand('/add model-a'), { name: 'add', argument: 'model-a' });
  assert.deepEqual(connect.parseSlashCommand('/delete'), { name: 'delete', argument: '' });
  assert.deepEqual(connect.parseSlashCommand('/rm model-a'), { name: 'delete', argument: 'model-a' });
  assert.equal(connect.parseSlashCommand('/difficulty high').unknown, true);
  assert.equal(connect.parseSlashCommand('/nope').unknown, true);
  assert.equal(connect.parseSlashCommand('add model-a'), undefined);
});

test('parseWorkerRouteInput requires service, model, and effort', () => {
  assert.deepEqual(connect.parseWorkerRouteInput('codex gpt-5.6-sol high'), {
    service: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'high',
  });
  assert.equal(connect.parseWorkerRouteInput('codex'), undefined);
  assert.equal(connect.parseWorkerRouteInput('codex gpt-5.6-sol'), undefined);
  assert.deepEqual(connect.parseWorkerRouteInput('codex gpt-5.6-sol custom'), {
    service: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'custom',
  });
});

test('parseArguments rejects the removed worker-level difficulty option', () => {
  assert.throws(
    () => connect.parseArguments(['--cli', 'worker', '--difficulty', 'hard_task']),
    /Unknown argument: --difficulty/,
  );
});

test('removeAgent drops one worker from local config', () => {
  const next = connect.removeAgent(
    { agents: [{ id: 'alpha' }, { id: 'beta' }] },
    'alpha',
  );
  assert.deepEqual(next.agents.map((agent) => agent.id), ['beta']);
});

test('assignRoute moves a model instead of duplicating it', () => {
  assert.deepEqual(
    connect.assignRoute(
      [{ difficulty: 'easy_task', model: 'model-a' }],
      { difficulty: 'hard_task', model: 'model-a' },
    ),
    [{ difficulty: 'hard_task', model: 'model-a' }],
  );
});

test('removeRoute removes only the matching model and effort', () => {
  const routes = [
    { difficulty: 'easy_task', model: 'model-a', effort: 'low' },
    { difficulty: 'standard_task', model: 'model-a', effort: 'high' },
    { difficulty: 'hard_task', model: 'model-b', effort: 'high' },
  ];
  assert.deepEqual(
    connect.removeRoute(routes, { model: 'model-a', effort: 'high' }),
    [routes[0], routes[2]],
  );
  assert.deepEqual(
    connect.removeRoute(routes, { model: 'model-a', effort: 'custom' }),
    routes,
  );
});

test('routeRows exposes friendly labels while preserving internal values', () => {
  const rows = connect.routeRows([{ difficulty: 'easy_task', model: 'model-a' }]);

  assert.deepEqual(rows.map(({ title, value }) => ({ title, value })), [
    { title: 'Easy task', value: 'easy_task' },
    { title: 'Standard task', value: 'standard_task' },
    { title: 'Hard task', value: 'hard_task' },
  ]);
  assert.equal(
    connect.formatRouteAssignment({ difficulty: 'hard_task', model: 'model-a', effort: 'high' }),
    'Hard task → model-a · effort:high',
  );
});

test('modelRows exposes each configured route as a selectable model', () => {
  const rows = connect.modelRows([
    {
      id: 'worker',
      command: '/bin/worker',
      routes: [
        { difficulty: 'easy_task', model: 'fast', effort: 'low' },
        { difficulty: 'hard_task', model: 'strong', effort: 'high' },
      ],
    },
  ]);

  assert.deepEqual(rows.map(({ title, value, difficulty, effort }) => ({
    title, value, difficulty, effort,
  })), [
    { title: 'fast', value: 'worker', difficulty: 'easy_task', effort: 'low' },
    { title: 'strong', value: 'worker', difficulty: 'hard_task', effort: 'high' },
  ]);
});

test('applyModelList adds without duplicates', () => {
  assert.deepEqual(connect.applyModelList(['a'], { add: 'b' }), ['a', 'b']);
  assert.deepEqual(connect.applyModelList(['a', 'b'], { add: 'a' }), ['a', 'b']);
});

test('pinModel inserts or replaces --model after the prompt', () => {
  assert.deepEqual(
    connect.pinModel(['-p', '{{prompt}}', '--always-approve'], 'model-a'),
    ['-p', '{{prompt}}', '--model', 'model-a', '--always-approve'],
  );
  assert.deepEqual(
    connect.pinModel(['-p', '{{prompt}}', '--model', 'old'], 'new'),
    ['-p', '{{prompt}}', '--model', 'new'],
  );
  assert.deepEqual(
    connect.pinModel(['-p', '{{prompt}}', '--model', 'old'], ''),
    ['-p', '{{prompt}}'],
  );
});

test('upsertAgent replaces one worker without dropping the others', () => {
  const next = connect.upsertAgent(
    { state_dir: './.agent-broker', agents: [{ id: 'alpha' }, { id: 'beta', enabled: false }] },
    { id: 'beta', enabled: true, models: ['model-a'] },
  );
  assert.equal(next.agents[0].id, 'alpha');
  assert.equal(next.agents[1].enabled, true);
  assert.deepEqual(next.agents[1].models, ['model-a']);
});

test('resolveWorker connects a typed command that is not in local config', () => {
  const command = process.execPath;
  const worker = connect.resolveWorker(command, { agents: [] });
  assert.equal(worker.resolvedCommand, command);
  assert.equal(worker.id, basename(command));
  assert.deepEqual(worker.args, ['-p', '{{prompt}}']);
  assert.equal(worker.adapter, 'native-cli');
});

test('genericWorker uses the codex-exec adapter for Codex', () => {
  const worker = connect.genericWorker('codex', '/opt/local/bin/codex');
  assert.equal(worker.adapter, 'codex-exec');
  assert.equal(worker.args, undefined);
});

test('resolveWorker reuses a local alias when the command already exists', () => {
  const command = process.execPath;
  const worker = connect.resolveWorker('alpha', {
    agents: [{
      id: 'alpha',
      command,
      args: ['-p', '{{prompt}}', '--always-approve'],
    }],
  });
  assert.equal(worker.id, 'alpha');
  assert.equal(worker.resolvedCommand, command);
  assert.deepEqual(worker.args, ['-p', '{{prompt}}', '--always-approve']);
});

test('mapKeypress keeps typed characters and named keys', () => {
  assert.equal(connect.mapKeypress('k', { name: 'k' }), 'k');
  assert.equal(connect.mapKeypress('i', { name: 'i' }), 'i');
  assert.equal(connect.mapKeypress('/', { name: 'slash' }), '/');
  assert.equal(connect.mapKeypress(undefined, { name: 'up' }), 'up');
  assert.equal(connect.mapKeypress('\r', { name: 'return' }), 'enter');
  assert.equal(connect.mapKeypress(undefined, { name: 'escape' }), 'esc');
  assert.equal(connect.mapKeypress('u', { name: 'u', ctrl: true }), 'ctrl-u');
});

test('pickDifficulty returns the level selected in the picker', async () => {
  const screen = {
    size: () => ({ cols: 100, rows: 24 }),
    paint: () => {},
    onKey: (handler) => {
      setImmediate(() => {
        handler('down');
        handler('enter');
      });
      return () => {};
    },
  };

  assert.equal(await connect.pickDifficulty(screen, 'worker', 'model-a'), 'standard_task');
});

test('pickDifficulty wraps the selected difficulty description instead of truncating it', async () => {
  let rendered = [];
  const screen = {
    size: () => ({ cols: 40, rows: 12 }),
    paint: (lines) => {
      rendered = lines;
    },
    onKey: (handler) => {
      setImmediate(() => handler('enter'));
      return () => {};
    },
  };

  assert.equal(await connect.pickDifficulty(screen, 'worker', 'model-a'), 'easy_task');
  const plain = rendered.map((line) => line.replace(/\x1b\[[0-9;]*m/g, '').trim());
  const description = 'Clear, limited scope with no design decision.';
  assert.equal(plain.filter(Boolean).join(' ').includes(description), true);
});

test('pickModelAction offers Verify before other model actions', async () => {
  const screenFor = (keys) => ({
    size: () => ({ cols: 100, rows: 24 }),
    paint: () => {},
    onKey: (handler) => {
      setImmediate(() => keys.forEach(handler));
      return () => {};
    },
  });
  const route = {
    value: 'worker',
    model: 'model-a',
    difficulty: 'standard_task',
  };

  assert.equal(await connect.pickModelAction(screenFor(['enter']), route), 'verify');
  assert.equal(await connect.pickModelAction(screenFor(['down', 'enter']), route), 'delete');
  assert.equal(await connect.pickModelAction(screenFor(['down', 'down', 'enter']), route), 'back');
});

test('formatVerificationResult reports the selected model outcome', () => {
  const route = { value: 'worker', model: 'model-a', difficulty: 'standard_task' };
  assert.equal(
    connect.formatVerificationResult(route, { verified: true }),
    'Verified model-a (worker · Standard task).',
  );
  assert.equal(
    connect.formatVerificationResult(route, { verified: false, summary: 'login required' }),
    'Verification failed for model-a: login required',
  );
});

test('showVerificationResult waits for close and renders the result', async () => {
  let rendered = [];
  const screen = {
    size: () => ({ cols: 100, rows: 24 }),
    paint: (lines) => {
      rendered = lines;
    },
    onKey: (handler) => {
      setImmediate(() => handler('enter'));
      return () => {};
    },
  };
  const route = { value: 'worker', model: 'model-a', difficulty: 'standard_task' };

  await connect.showVerificationResult(screen, route, {
    verified: true,
    summary: 'OK',
  });

  const plain = rendered.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(plain, /Connected/);
  assert.match(plain, /OK/);
  assert.match(plain, /Enter or Esc close/);
});

test('filterRows keeps rows matching the typed query', () => {
  const rows = [
    { title: 'alpha', meta: 'bin-a', value: 'alpha' },
    { title: 'beta', meta: 'bin-b', value: 'beta' },
  ];
  assert.deepEqual(connect.filterRows(rows, 'bin-a').map((row) => row.title), ['alpha']);
  assert.deepEqual(connect.filterRows(rows, '').map((row) => row.title), ['alpha', 'beta']);
});

test('buildCatalog lists only runnable local CLIs', () => {
  const command = process.execPath;
  const catalog = connect.buildCatalog({
    agents: [
      { id: 'missing', command: '/no/such/bin' },
      { id: 'worker', command, args: ['-p', '{{prompt}}'] },
    ],
  });
  assert.deepEqual(catalog.map((agent) => agent.id), ['worker']);
});

test('agentFromTemplate does not persist catalog-only fields', () => {
  const agent = connect.agentFromTemplate({
    id: 'worker',
    command: 'cli',
    args: ['-p', '{{prompt}}'],
    billing: { mode: 'subscription', fallback: 'forbidden' },
    resolvedCommand: '/tmp/cli',
    installed: true,
    currentModel: 'old',
  }, { command: '/abs/cli', model: 'model-a' });

  assert.equal(agent.command, '/abs/cli');
  assert.deepEqual(agent.models, ['model-a']);
  assert.equal(agent.resolvedCommand, undefined);
  assert.equal(agent.installed, undefined);
  assert.equal(agent.currentModel, undefined);
  assert.equal(agent.model, 'model-a');
  assert.deepEqual(agent.args, ['-p', '{{prompt}}', '--model', 'model-a']);
});

async function makeConnectSandbox(t) {
  const directory = await mkdtemp(join(tmpdir(), 'connect-worker-'));
  const examplePath = join(directory, 'example.json');
  const configPath = join(directory, 'local.json');
  await writeFile(examplePath, JSON.stringify({ state_dir: join(directory, 'state'), agents: [] }));
  t.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, examplePath, configPath };
}

test('connectWorker writes a CLI without pinning a model', async (t) => {
  const { directory, examplePath, configPath } = await makeConnectSandbox(t);
  const command = process.execPath;
  await writeFile(configPath, JSON.stringify({
    state_dir: join(directory, 'state'),
    agents: [{
      id: 'worker',
      command,
      args: ['-p', '{{prompt}}', '--model', 'model-a'],
      probe: { args: ['--version'] },
      billing: { mode: 'subscription', fallback: 'forbidden' },
      models: ['model-a'],
    }],
  }));

  const result = await connect.connectWorker({
    cli: 'worker',
    example: examplePath,
    config: configPath,
    repoRoot: directory,
    verify: false,
  });

  assert.equal(result.model, null);
  const saved = JSON.parse(await readFile(configPath, 'utf8'));
  assert.deepEqual(saved.agents[0].args, ['-p', '{{prompt}}']);
  assert.equal(saved.agents[0].model, undefined);
  assert.deepEqual(saved.agents[0].models, ['model-a']);
});

test('connectWorker writes the selected model into local config without a ping', async (t) => {
  const { directory, examplePath, configPath } = await makeConnectSandbox(t);
  const command = process.execPath;
  await writeFile(configPath, JSON.stringify({
    state_dir: join(directory, 'state'),
    agents: [{
      id: 'worker',
      adapter: 'native-cli',
      enabled: false,
      command,
      args: ['-p', '{{prompt}}'],
      probe: { args: ['--version'] },
      billing: { mode: 'subscription', fallback: 'forbidden' },
    }],
  }));

  const result = await connect.connectWorker({
    cli: 'worker',
    model: 'model-a',
    example: examplePath,
    config: configPath,
    repoRoot: directory,
    verify: false,
  });

  assert.equal(result.written, true);
  assert.equal(result.model, 'model-a');
  const saved = JSON.parse(await readFile(configPath, 'utf8'));
  assert.equal(saved.agents[0].enabled, true);
  assert.equal(saved.agents[0].command, command);
  assert.deepEqual(saved.agents[0].args, ['-p', '{{prompt}}', '--model', 'model-a']);
  assert.equal(saved.agents[0].model, 'model-a');
  assert.deepEqual(saved.agents[0].models, ['model-a']);
});

test('connectWorker moves an existing model to the selected route', async (t) => {
  const { directory, examplePath, configPath } = await makeConnectSandbox(t);
  const command = process.execPath;
  await writeFile(configPath, JSON.stringify({
    state_dir: join(directory, 'state'),
    agents: [{
      id: 'worker',
      adapter: 'native-cli',
      command,
      args: ['-p', '{{prompt}}'],
      probe: { args: ['--version'] },
      billing: { mode: 'subscription', fallback: 'forbidden' },
      difficulty: 'easy_task',
      routes: [{ difficulty: 'easy_task', model: 'model-a' }],
    }],
  }));

  const result = await connect.connectWorker({
    cli: 'worker',
    setRoute: { difficulty: 'hard_task', model: 'model-a' },
    example: examplePath,
    config: configPath,
    repoRoot: directory,
    verify: false,
  });

  const saved = JSON.parse(await readFile(configPath, 'utf8'));
  assert.deepEqual(result.routes, [{ difficulty: 'hard_task', model: 'model-a' }]);
  assert.equal(Object.hasOwn(saved.agents[0], 'difficulty'), false);
  assert.deepEqual(saved.agents[0].routes, [{ difficulty: 'hard_task', model: 'model-a' }]);
});

test('verifyWorker sends a short prompt through the selected model without rewriting config', async (t) => {
  const { directory, configPath } = await makeConnectSandbox(t);
  const stateDir = join(directory, 'state');
  const logPath = join(directory, 'fake-cli.jsonl');
  await mkdir(stateDir);
  await writeFile(configPath, JSON.stringify({
    state_dir: stateDir,
    agents: [{
      id: 'worker',
      adapter: 'native-cli',
      enabled: true,
      command: process.execPath,
      args: [
        fixturePath,
        '--mode', 'complete',
        '--label', 'worker',
        '--log', logPath,
        '--prompt', '{{prompt}}',
        '--cwd', '{{cwd}}',
      ],
      probe: {
        args: [
          fixturePath,
          '--probe',
          '--mode', 'available',
          '--label', 'worker',
          '--log', logPath,
        ],
      },
      billing: { mode: 'subscription', fallback: 'forbidden' },
      routes: [{ difficulty: 'hard_task', model: 'strong', effort: 'high' }],
    }],
  }));
  const before = await readFile(configPath, 'utf8');

  const result = await connect.verifyWorker({
    agentId: 'worker',
    difficulty: 'hard_task',
    model: 'strong',
    config: configPath,
    repoRoot: directory,
  });

  assert.equal(result.verified, true);
  assert.equal(result.ping.status, 'completed');
  assert.equal(await readFile(configPath, 'utf8'), before);
  const events = (await readFile(logPath, 'utf8')).trim().split('\n').map(JSON.parse);
  const run = events.find((event) => event.kind === 'run');
  assert.equal(run.prompt, 'Reply exactly: OK');
  assert.equal(run.argv[run.argv.indexOf('--model') + 1], 'strong');
});

test('connectWorker deletes only the exactly matching route', async (t) => {
  const { directory, examplePath, configPath } = await makeConnectSandbox(t);
  const command = process.execPath;
  const routes = [
    { difficulty: 'easy_task', model: 'model-a', effort: 'low' },
    { difficulty: 'standard_task', model: 'model-a', effort: 'high' },
    { difficulty: 'hard_task', model: 'model-b', effort: 'high' },
  ];
  await writeFile(configPath, JSON.stringify({
    state_dir: join(directory, 'state'),
    agents: [{
      id: 'worker',
      adapter: 'native-cli',
      command,
      args: ['-p', '{{prompt}}'],
      probe: { args: ['--version'] },
      billing: { mode: 'subscription', fallback: 'forbidden' },
      models: ['model-a', 'model-b'],
      routes,
    }],
  }));

  await connect.connectWorker({
    cli: 'worker',
    removeRoute: { model: 'model-a', effort: 'high' },
    example: examplePath,
    config: configPath,
    repoRoot: directory,
    verify: false,
  });

  const saved = JSON.parse(await readFile(configPath, 'utf8'));
  assert.deepEqual(saved.agents[0].routes, [routes[0], routes[2]]);
  assert.deepEqual(saved.agents[0].models, ['model-a', 'model-b']);
});

test('connectWorker removes a model after deleting its last route', async (t) => {
  const { directory, examplePath, configPath } = await makeConnectSandbox(t);
  const command = process.execPath;
  await writeFile(configPath, JSON.stringify({
    state_dir: join(directory, 'state'),
    agents: [{
      id: 'worker',
      adapter: 'native-cli',
      command,
      args: ['-p', '{{prompt}}'],
      probe: { args: ['--version'] },
      billing: { mode: 'subscription', fallback: 'forbidden' },
      models: ['model-a', 'model-b'],
      routes: [
        { difficulty: 'easy_task', model: 'model-a', effort: 'low' },
        { difficulty: 'hard_task', model: 'model-b', effort: 'high' },
      ],
    }],
  }));

  await connect.connectWorker({
    cli: 'worker',
    removeRoute: { model: 'model-a', effort: 'low' },
    example: examplePath,
    config: configPath,
    repoRoot: directory,
    verify: false,
  });

  const saved = JSON.parse(await readFile(configPath, 'utf8'));
  assert.deepEqual(saved.agents[0].routes, [
    { difficulty: 'hard_task', model: 'model-b', effort: 'high' },
  ]);
  assert.deepEqual(saved.agents[0].models, ['model-b']);
});

test('connectWorker rejects a delete when effort does not match', async (t) => {
  const { directory, examplePath, configPath } = await makeConnectSandbox(t);
  const command = process.execPath;
  const config = {
    state_dir: join(directory, 'state'),
    agents: [{
      id: 'worker',
      command,
      args: ['-p', '{{prompt}}'],
      routes: [{ difficulty: 'easy_task', model: 'model-a', effort: 'low' }],
    }],
  };
  await writeFile(configPath, JSON.stringify(config));

  await assert.rejects(
    connect.connectWorker({
      cli: 'worker',
      removeRoute: { model: 'model-a', effort: 'high' },
      example: examplePath,
      config: configPath,
      repoRoot: directory,
      verify: false,
    }),
    /Route not found: worker model-a high/,
  );
  assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), config);
});
