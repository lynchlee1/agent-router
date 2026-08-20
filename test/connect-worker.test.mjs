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

test('parseModelList reads JSON catalogs with slug fields', () => {
  assert.deepEqual(
    connect.parseModelList('{"models":[{"slug":"model-a","display_name":"Model A"}]}'),
    [{ id: 'model-a', label: 'Model A' }],
  );
});

test('slashCompletions filters commands and arguments', () => {
  const commands = [
    {
      name: 'add',
      hint: '<model> <low|medium|high>',
      arguments: (head) => (head.length === 0 ? ['gpt-x', 'gpt-y'] : ['low', 'medium', 'high']),
      complete: (insert) => insert.split(/\s+/).length >= 3,
    },
    { name: 'delete', hint: '<id>', arguments: () => ['gpt-x'] },
  ];
  assert.deepEqual(
    connect.slashCompletions('/', commands).map((item) => item.title),
    ['/add    <model> <low|medium|high>', '/delete <id>'],
  );
  assert.deepEqual(
    connect.slashCompletions('/ad', commands).map((item) => item.insert),
    ['/add '],
  );
  assert.deepEqual(
    connect.slashCompletions('/add g', commands).map((item) => item.title),
    ['gpt-x', 'gpt-y'],
  );
  assert.deepEqual(
    connect.slashCompletions('/add gpt-x ', commands).map((item) => item.insert),
    ['/add gpt-x low', '/add gpt-x medium', '/add gpt-x high'],
  );
});

test('parseSlashCommand maps /add and /delete', () => {
  assert.deepEqual(connect.parseSlashCommand('/add model-a'), { name: 'add', argument: 'model-a' });
  assert.deepEqual(connect.parseSlashCommand('/delete'), { name: 'delete', argument: '' });
  assert.deepEqual(connect.parseSlashCommand('/rm model-a'), { name: 'delete', argument: 'model-a' });
  assert.deepEqual(connect.parseSlashCommand('/difficulty high'), { name: 'difficulty', argument: 'high' });
  assert.equal(connect.parseSlashCommand('/nope').unknown, true);
  assert.equal(connect.parseSlashCommand('add model-a'), undefined);
});

test('removeAgent drops one worker from local config', () => {
  const next = connect.removeAgent(
    { agents: [{ id: 'alpha' }, { id: 'beta' }] },
    'alpha',
  );
  assert.deepEqual(next.agents.map((agent) => agent.id), ['beta']);
});

test('parseRouteAssignment reads model and difficulty', () => {
  assert.deepEqual(
    connect.parseRouteAssignment('gpt-x high'),
    { model: 'gpt-x', difficulty: 'high' },
  );
  assert.deepEqual(
    connect.parseRouteAssignment('gpt-x', 'low'),
    { model: 'gpt-x', difficulty: 'low' },
  );
});

test('applyModelList adds and removes without duplicates', () => {
  assert.deepEqual(connect.applyModelList(['a'], { add: 'b' }), ['a', 'b']);
  assert.deepEqual(connect.applyModelList(['a', 'b'], { add: 'a' }), ['a', 'b']);
  assert.deepEqual(connect.applyModelList(['a', 'b'], { remove: 'a' }), ['b']);
});

test('parseModelList reads tab-separated and bullet model lists', () => {
  assert.deepEqual(
    connect.parseModelList('model-a\tModel A\n'),
    [{ id: 'model-a', label: 'Model A' }],
  );
  assert.deepEqual(
    connect.parseModelList('Available models:\n  * model-b (default)\n  - model-c\n'),
    [
      { id: 'model-b', label: '(default)' },
      { id: 'model-c', label: 'model-c' },
    ],
  );
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

test('listModelsFor returns an empty list when the CLI has no models command', async () => {
  assert.deepEqual(await connect.listModelsFor(process.execPath), []);
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
