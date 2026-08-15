#!/usr/bin/env node

import { resolve } from 'node:path';

import { startServer } from '../src/server.js';

function usage() {
  process.stdout.write('Usage:\n  agent-broker --config <agents.json>\n');
}

function parseArguments(argv) {
  let configPath = process.env.AGENT_BROKER_CONFIG;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') return { help: true };
    if (argument === '--config') {
      configPath = argv[index + 1];
      index += 1;
      continue;
    }
    throw new TypeError(`Unknown argument: ${argument}`);
  }
  if (!configPath) throw new TypeError('Missing --config <agents.json>.');
  return { configPath: resolve(configPath) };
}

try {
  const argv = process.argv.slice(2);
  const options = parseArguments(argv);
  if (options.help) {
    usage();
  } else {
    await startServer(options);
  }
} catch (error) {
  process.stderr.write(`agent-broker: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
