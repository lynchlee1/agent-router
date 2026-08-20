#!/usr/bin/env node

import { accessSync, constants } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRootFromScript = resolve(fileURLToPath(new URL('../', import.meta.url)));

export function registration(repoRoot = repoRootFromScript) {
  const brokerPath = join(repoRoot, 'bin', 'agent-broker.js');
  const configPath = join(repoRoot, 'config', 'agents.local.json');
  return {
    brokerPath,
    configPath,
    command: 'codex',
    args: [
      'mcp',
      'add',
      'agent-broker',
      '--',
      process.execPath,
      brokerPath,
      '--config',
      configPath,
    ],
  };
}

export function register({ repoRoot = repoRootFromScript, spawn = spawnSync } = {}) {
  const options = registration(repoRoot);
  try {
    accessSync(options.brokerPath, constants.R_OK);
    accessSync(options.configPath, constants.R_OK);
  } catch (error) {
    if (error?.path === options.configPath) {
      throw new Error('Missing config/agents.local.json. Run npm run connect first.');
    }
    throw new Error('Missing bin/agent-broker.js.');
  }

  const result = spawn(options.command, options.args, { stdio: 'inherit' });
  if (result.error?.code === 'ENOENT') {
    throw new Error('Codex CLI was not found on PATH.');
  }
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Codex MCP registration failed with exit code ${result.status}.`);
  }
  return options;
}

const invokedDirectly = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  try {
    register();
    process.stdout.write('Restart Codex to load agent-broker.\n');
  } catch (error) {
    process.stderr.write(`register: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
