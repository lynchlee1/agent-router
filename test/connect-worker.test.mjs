import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
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
const connect = await import(pathToFileURL(scriptPath).href);

test('slashCompletions filters commands and arguments', () => {
  const commands = [
    {
      name: 'add',
      hint: '<model> <effort>',
      arguments: (head) => (head.length === 1 ? connect.EFFORTS : []),
      complete: (insert) => Boolean(connect.parseRouteInput(connect.parseSlashCommand(insert)?.argument)),
    },
    { name: 'delete', hint: '<id>', arguments: () => ['gpt-x'] },
  ];
  assert.deepEqual(
    connect.slashCompletions('/', commands).map((item) => item.title),
    ['/add    <model> <effort>', '/delete <id>'],
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
    ['/add gpt-x high'],
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

test('parseRouteInput reads a model and effort', () => {
  assert.deepEqual(connect.parseRouteInput('gpt-5.6-sol high'), {
    model: 'gpt-5.6-sol',
    effort: 'high',
  });
  assert.equal(connect.parseRouteInput('gpt-5.6-sol'), undefined);
  assert.equal(connect.parseRouteInput('gpt-5.6-sol extreme'), undefined);
});

test('parseWorkerRouteInput requires service, model, and effort', () => {
  assert.deepEqual(connect.parseWorkerRouteInput('codex gpt-5.6-sol high'), {
    service: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'high',
  });
  assert.equal(connect.parseWorkerRouteInput('codex'), undefined);
  assert.equal(connect.parseWorkerRouteInput('codex gpt-5.6-sol'), undefined);
  assert.equal(connect.parseWorkerRouteInput('codex gpt-5.6-sol extreme'), undefined);
});

test('parseArguments accepts a difficulty change', () => {
  assert.deepEqual(
    connect.parseArguments(['--cli', 'worker', '--difficulty', 'hard_task', '--no-verify']),
    {
      cli: 'worker',
      difficulty: 'hard_task',
      listClis: false,
      verify: false,
      help: false,
    },
  );
});

test('removeAgent drops one worker from local config', () => {
  const next = connect.removeAgent(
    { agents: [{ id: 'alpha' }, { id: 'beta' }] },
    'alpha',
  );
  assert.deepEqual(next.agents.map((agent) => agent.id), ['beta']);
});

test('changeAgentDifficulty moves a single route', () => {
  const changed = connect.changeAgentDifficulty({
    difficulty: 'easy_task',
    routes: [{ difficulty: 'easy_task', model: 'model-a' }],
  }, 'hard_task');

  assert.equal(changed.difficulty, 'hard_task');
  assert.deepEqual(changed.routes, [{ difficulty: 'hard_task', model: 'model-a' }]);
  assert.throws(
    () => connect.changeAgentDifficulty({
      routes: [
        { difficulty: 'easy_task', model: 'fast' },
        { difficulty: 'hard_task', model: 'strong' },
      ],
    }, 'standard_task'),
    /multiple routes/i,
  );
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

test('routeRows exposes friendly labels while preserving internal values', () => {
  const rows = connect.routeRows([{ difficulty: 'easy_task', model: 'model-a' }]);

  assert.deepEqual(rows.map(({ title, value }) => ({ title, value })), [
    { title: 'Easy task', value: 'easy_task' },
    { title: 'Standard task', value: 'standard_task' },
    { title: 'Hard task', value: 'hard_task' },
  ]);
});

test('applyModelList adds and removes without duplicates', () => {
  assert.deepEqual(connect.applyModelList(['a'], { add: 'b' }), ['a', 'b']);
  assert.deepEqual(connect.applyModelList(['a', 'b'], { add: 'a' }), ['a', 'b']);
  assert.deepEqual(connect.applyModelList(['a', 'b'], { remove: 'a' }), ['b']);
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

test('editRoutes accepts /add model effort and then selects difficulty', async (t) => {
  const { directory, examplePath, configPath } = await makeConnectSandbox(t);
  await writeFile(configPath, JSON.stringify({
    state_dir: join(directory, 'state'),
    agents: [{
      id: 'worker',
      adapter: 'codex-exec',
      command: process.execPath,
      args: ['-p', '{{prompt}}'],
      billing: { mode: 'subscription', fallback: 'forbidden' },
      difficulty: 'standard_task',
      routes: [],
    }],
  }));
  let screenCalls = 0;
  const screen = {
    size: () => ({ cols: 100, rows: 24 }),
    paint: () => {},
    onKey: (handler) => {
      const keys = screenCalls++ === 0
        ? [...'/add model-a high', 'enter']
        : ['down', 'down', 'enter'];
      setImmediate(() => keys.forEach(handler));
      return () => {};
    },
  };
  const result = await connect.editRoutes(screen, {
    example: examplePath,
    config: configPath,
    repoRoot: directory,
  }, 'worker');

  assert.equal(result, 'worker  Hard task → model-a · effort:high');
  const saved = JSON.parse(await readFile(configPath, 'utf8'));
  assert.equal(saved.agents[0].difficulty, 'hard_task');
  assert.deepEqual(saved.agents[0].routes, [{ difficulty: 'hard_task', model: 'model-a', effort: 'high' }]);
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

test('connectWorker changes the worker difficulty and its single route', async (t) => {
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
    difficulty: 'hard_task',
    example: examplePath,
    config: configPath,
    repoRoot: directory,
    verify: false,
  });

  assert.equal(result.difficulty, 'hard_task');
  const saved = JSON.parse(await readFile(configPath, 'utf8'));
  assert.equal(saved.agents[0].difficulty, 'hard_task');
  assert.deepEqual(saved.agents[0].routes, [{ difficulty: 'hard_task', model: 'model-a' }]);
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

  await connect.connectWorker({
    cli: 'worker',
    setRoute: { difficulty: 'hard_task', model: 'model-a' },
    example: examplePath,
    config: configPath,
    repoRoot: directory,
    verify: false,
  });

  const saved = JSON.parse(await readFile(configPath, 'utf8'));
  assert.equal(saved.agents[0].difficulty, 'hard_task');
  assert.deepEqual(saved.agents[0].routes, [{ difficulty: 'hard_task', model: 'model-a' }]);
});
