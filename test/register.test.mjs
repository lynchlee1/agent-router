import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { register, registration } from '../bin/register.js';

test('registration builds the Codex MCP command from the repository path', () => {
  const repoRoot = '/tmp/agent broker';
  const result = registration(repoRoot);

  assert.equal(result.command, 'codex');
  assert.deepEqual(result.args, [
    'mcp',
    'add',
    'agent-broker',
    '--',
    process.execPath,
    join(repoRoot, 'bin', 'agent-broker.js'),
    '--config',
    join(repoRoot, 'config', 'agents.local.json'),
  ]);
});

test('register invokes Codex after validating local files', async (t) => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'agent-broker-register-'));
  t.after(() => rm(repoRoot, { recursive: true, force: true }));
  await mkdir(join(repoRoot, 'bin'));
  await mkdir(join(repoRoot, 'config'));
  await writeFile(join(repoRoot, 'bin', 'agent-broker.js'), '');
  await writeFile(join(repoRoot, 'config', 'agents.local.json'), '{}');

  let invocation;
  register({
    repoRoot,
    spawn: (command, args, options) => {
      invocation = { command, args, options };
      return { status: 0 };
    },
  });

  assert.equal(invocation.command, 'codex');
  assert.equal(invocation.args[2], 'agent-broker');
  assert.deepEqual(invocation.options, { stdio: 'inherit' });
});

test('register explains how to create a missing local config', async (t) => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'agent-broker-register-'));
  t.after(() => rm(repoRoot, { recursive: true, force: true }));
  await mkdir(join(repoRoot, 'bin'));
  await writeFile(join(repoRoot, 'bin', 'agent-broker.js'), '');

  assert.throws(
    () => register({ repoRoot, spawn: () => ({ status: 0 }) }),
    /Run npm run connect first/,
  );
});
