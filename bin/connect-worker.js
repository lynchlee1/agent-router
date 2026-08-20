#!/usr/bin/env node

import { accessSync, constants, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, isAbsolute, join, resolve } from 'node:path';
import readline from 'node:readline';
import tty from 'node:tty';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  AgentBroker,
  routesFrom,
  TASK_DIFFICULTIES,
  taskDifficulty,
  upsertRoute,
} from '../src/index.js';

const repoRootFromScript = resolve(fileURLToPath(new URL('../', import.meta.url)));
const SUBSCRIPTION_BILLING = { mode: 'subscription', fallback: 'forbidden' };
const VERSION_PROBE = { args: ['--version'] };
const NATIVE_PROMPT_ARGS = ['-p', '{{prompt}}'];

export function parseArguments(argv) {
  const options = {
    listClis: false,
    verify: true,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('-')) {
        throw new TypeError(`${argument} requires a value.`);
      }
      index += 1;
      return value;
    };
    if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--cli') options.cli = next();
    else if (argument === '--model') options.model = next();
    else if (argument === '--config') options.config = next();
    else if (argument === '--example') options.example = next();
    else if (argument === '--repo-root') options.repoRoot = next();
    else if (argument === '--list-clis') options.listClis = true;
    else if (argument === '--no-verify') options.verify = false;
    else throw new TypeError(`Unknown argument: ${argument}`);
  }
  return options;
}

export function slashCompletions(query, commands = []) {
  if (!query.startsWith('/')) return [];
  const match = query.match(/^\/([^\s]*)(?:(\s)(.*))?$/);
  const namePart = (match?.[1] ?? '').toLowerCase();
  const hasSpace = Boolean(match?.[2]);
  const rest = match?.[3] ?? '';

  if (!hasSpace) {
    const matches = commands.filter((command) => command.name.startsWith(namePart));
    const nameWidth = Math.max(0, ...matches.map((command) => `/${command.name}`.length));
    return matches.map((command) => {
      const name = `/${command.name}`.padEnd(nameWidth);
      return {
        title: command.hint ? `${name} ${command.hint}` : name.trimEnd(),
        meta: '',
        insert: `/${command.name}${command.hint ? ' ' : ''}`,
        complete: command.complete?.(`/${command.name}`) ?? !command.hint,
      };
    });
  }

  const command = commands.find((item) => item.name === namePart);
  if (!command?.arguments) return [];
  const trimmed = rest.trim();
  const endsWithSpace = rest.endsWith(' ');
  const tokens = trimmed ? trimmed.split(/\s+/) : [];
  const last = endsWithSpace ? '' : (tokens.at(-1) ?? '');
  const head = endsWithSpace ? tokens : tokens.slice(0, -1);
  const prefix = [`/${command.name}`, ...head].join(' ');
  return (command.arguments(head, last) ?? [])
    .map(String)
    .filter((value) => value.toLowerCase().startsWith(last.toLowerCase()))
    .map((value) => {
      const insert = `${prefix} ${value}`;
      return {
        title: value,
        meta: '',
        insert,
        complete: command.complete?.(insert) ?? false,
      };
    });
}

export function parseSlashCommand(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return undefined;
  const [rawName, ...rest] = trimmed.slice(1).split(/\s+/);
  const name = (rawName ?? '').toLowerCase();
  const argument = rest.join(' ').trim();
  if (name === 'add') return { name: 'add', argument };
  if (name === 'delete' || name === 'remove' || name === 'rm') return { name: 'delete', argument };
  return { name, argument, unknown: true };
}

export function parseWorkerRouteInput(argument) {
  const parts = (argument ?? '').trim().split(/\s+/).filter(Boolean);
  const service = parts.shift();
  const effort = parts.pop();
  const model = parts.join(' ');
  return service && model && effort ? { service, model, effort } : undefined;
}

export function applyModelList(models = [], { add } = {}) {
  const next = [];
  for (const id of models) {
    if (typeof id === 'string' && id && !next.includes(id)) next.push(id);
  }
  if (add && !next.includes(add)) next.push(add);
  return next;
}

export function routeRows(routes) {
  const byDifficulty = new Map((routes ?? []).map((route) => [route.difficulty, route]));
  return TASK_DIFFICULTIES.map(({ value, title }) => ({
    title,
    meta: byDifficulty.has(value)
      ? `${byDifficulty.get(value).model}${byDifficulty.get(value).effort
        ? ` · effort:${byDifficulty.get(value).effort}`
        : ''}`
      : 'unassigned',
    value,
    model: byDifficulty.get(value)?.model || '',
    effort: byDifficulty.get(value)?.effort,
  }));
}

export function modelRows(catalog) {
  return catalog.flatMap((agent) => {
    const routes = routesFrom(agent);
    if (!routes.length) {
      return [{
        title: agent.id,
        detail: 'no routes',
        meta: displayPath(agent.command),
        value: agent.id,
      }];
    }
    return routes.map((route) => ({
      title: route.model,
      detail: `${agent.id} · ${taskDifficulty(route.difficulty).title}${route.effort
        ? ` · effort:${route.effort}`
        : ''}`,
      meta: displayPath(agent.command),
      value: agent.id,
      difficulty: route.difficulty,
      model: route.model,
      effort: route.effort,
    }));
  });
}

export function formatRouteAssignment(route) {
  const effort = route.effort ? ` · effort:${route.effort}` : '';
  return `${taskDifficulty(route.difficulty).title} → ${route.model}${effort}`;
}

export function assignRoute(routes, assignment) {
  const remaining = (routes ?? []).filter((route) => route.model !== assignment.model);
  return upsertRoute(remaining, assignment);
}

export function removeRoute(routes, { model, effort }) {
  return (routes ?? []).filter((route) => route.model !== model || route.effort !== effort);
}

export function pinnedModelFrom(agent) {
  const index = (agent.args ?? []).indexOf('--model');
  if (index >= 0 && agent.args[index + 1]) return agent.args[index + 1];
  return undefined;
}

export function pinModel(args = [], model) {
  if (!model) {
    const next = [];
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] === '--model') {
        index += 1;
        continue;
      }
      next.push(args[index]);
    }
    return next;
  }
  const next = [...args];
  const index = next.indexOf('--model');
  if (index === -1) {
    const promptAt = next.indexOf('{{prompt}}');
    if (promptAt === -1) return [...next, '--model', model];
    next.splice(promptAt + 1, 0, '--model', model);
    return next;
  }
  if (index === next.length - 1) return [...next, model];
  next[index + 1] = model;
  return next;
}

export function upsertAgent(raw, agent) {
  const agents = [...(raw.agents ?? [])];
  const index = agents.findIndex((candidate) => candidate.id === agent.id);
  if (index === -1) agents.push(agent);
  else agents[index] = agent;
  return { ...raw, agents };
}

export function resolveCommand(command, pathEnv = process.env.PATH) {
  if (!command) return undefined;
  const candidates = isAbsolute(command) || command.includes('/') || command.includes('\\')
    ? [resolve(command)]
    : (pathEnv ?? '').split(delimiter).map((directory) => join(directory, command));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep looking on PATH.
    }
  }
  return undefined;
}

function decorateAgent(agent, resolvedCommand) {
  const next = {
    ...agent,
    ...(basename(resolvedCommand) === 'codex' ? { adapter: 'codex-exec' } : {}),
    resolvedCommand,
    installed: true,
  };
  if (next.adapter === 'codex-exec') {
    delete next.args;
    delete next.resume_args;
  } else {
    next.args = usableArgs(agent.args);
  }
  return next;
}

export function buildCatalog(local, pathEnv) {
  const byResolved = new Map();
  for (const agent of local.agents ?? []) {
    if (!agent?.id || !agent.command) continue;
    const resolvedCommand = resolveCommand(agent.command, pathEnv);
    if (!resolvedCommand || byResolved.has(resolvedCommand)) continue;
    byResolved.set(resolvedCommand, decorateAgent(agent, resolvedCommand));
  }
  return [...byResolved.values()];
}

export function findCatalogEntry(catalog, token) {
  if (!token) return undefined;
  const needle = token.toLowerCase();
  return catalog.find((agent) => matchesToken(agent, needle, token));
}

function matchesToken(agent, needle, token) {
  return agent.id === token
    || agent.command === token
    || (agent.label ?? '').toLowerCase() === needle
    || basename(agent.command ?? '') === token
    || (agent.resolvedCommand && (agent.resolvedCommand.endsWith(`/${token}`) || basename(agent.resolvedCommand) === token));
}

export function usableArgs(args) {
  if (!Array.isArray(args) || !args.includes('{{prompt}}')) {
    return [...NATIVE_PROMPT_ARGS];
  }
  return args;
}

export function genericWorker(id, command) {
  const codex = basename(command) === 'codex';
  return {
    id,
    label: id,
    adapter: codex ? 'codex-exec' : 'native-cli',
    command,
    ...(codex ? {} : { args: [...NATIVE_PROMPT_ARGS] }),
    probe: { args: [...VERSION_PROBE.args] },
    billing: { ...SUBSCRIPTION_BILLING },
  };
}

export function removeAgent(raw, id) {
  return {
    ...raw,
    agents: (raw.agents ?? []).filter((agent) => agent.id !== id),
  };
}

export function resolveWorker(token, local, pathEnv) {
  const trimmed = token?.trim();
  if (!trimmed) return undefined;
  const catalog = buildCatalog(local, pathEnv);
  const live = findCatalogEntry(catalog, trimmed);
  if (live) return live;

  const command = resolveCommand(trimmed, pathEnv);
  if (!command) return undefined;
  const id = trimmed.includes('/') || trimmed.includes('\\') ? basename(command) : trimmed;
  return decorateAgent(genericWorker(id, command), command);
}

export function agentFromTemplate(template, { command, model, models, routes }) {
  const {
    difficulty: _legacyDifficulty,
    resolvedCommand: _resolvedCommand,
    installed: _installed,
    currentModel: _currentModel,
    args: templateArgs,
    ...agent
  } = template;
  const nextRoutes = Array.isArray(routes) ? routes : routesFrom(agent);
  const nextModels = Array.isArray(models)
    ? models
    : applyModelList(
      [...(agent.models ?? []), ...nextRoutes.map((route) => route.model)],
      { add: model },
    );
  return {
    ...agent,
    enabled: true,
    command,
    ...(agent.adapter === 'codex-exec'
      ? {}
      : { args: pinModel(usableArgs(templateArgs), model) }),
    ...(model ? { model } : {}),
    models: nextModels,
    routes: nextRoutes,
  };
}

function loadJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw error;
  }
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function importBrokerInternals() {
  const module = await import('../src/index.js');
  return module.internals;
}

export async function connectWorker(options) {
  const repoRoot = resolve(options.repoRoot ?? repoRootFromScript);
  const examplePath = resolve(options.example ?? join(repoRoot, 'config', 'agents.example.json'));
  const configPath = resolve(options.config ?? join(repoRoot, 'config', 'agents.local.json'));
  const example = loadJson(examplePath);
  const local = loadJson(configPath, {
    state_dir: example.state_dir ?? './.agent-broker',
    agents: [],
  });
  const catalog = buildCatalog(local);

  if (options.listClis) return { catalog, configPath };

  const entry = resolveWorker(options.cli, local);
  if (!entry) {
    throw new Error(`Not found: ${options.cli}. Use /add <service>.`);
  }

  if (options.removeRoute) {
    const currentRoutes = routesFrom(entry);
    const routes = removeRoute(currentRoutes, options.removeRoute);
    if (routes.length === currentRoutes.length) {
      throw new Error(`Route not found: ${entry.id} ${options.removeRoute.model} ${options.removeRoute.effort}`);
    }
    const modelStillReferenced = routes.some((route) => route.model === options.removeRoute.model)
      || entry.model === options.removeRoute.model
      || pinnedModelFrom(entry) === options.removeRoute.model;
    const models = modelStillReferenced
      ? entry.models
      : (entry.models ?? []).filter((model) => model !== options.removeRoute.model);
    const configured = agentFromTemplate(entry, {
      command: entry.resolvedCommand,
      models,
      routes,
    });
    writeJson(configPath, upsertAgent(local, configured));
    return { configPath, agent_id: entry.id, routes, removed: true, written: true };
  }

  let model = options.model || undefined;
  let models;
  let routes;
  if (options.setRoute) {
    routes = assignRoute(routesFrom(entry), options.setRoute);
    models = applyModelList(entry.models ?? [], { add: options.setRoute.model });
  }
  let configured = agentFromTemplate(entry, { command: entry.resolvedCommand, model, models, routes });
  const next = upsertAgent(local, configured);
  writeJson(configPath, next);

  const result = {
    configPath,
    agent_id: configured.id,
    command: configured.command,
    model: model ?? null,
    routes: configured.routes,
    written: true,
  };
  if (options.verify === false) return result;

  const broker = new AgentBroker(configPath);
  const listed = await broker.listAgents({ refresh: true });
  const status = listed.agents.find((agent) => agent.id === configured.id);
  result.probe = status;
  if (status?.status !== 'available') {
    result.verified = false;
    result.summary = status?.reason ?? `${configured.id} is not available.`;
    return result;
  }
  if (options.verify === 'probe') {
    result.verified = true;
    return result;
  }
  const ping = await broker.delegate({
    task: `Reply with exactly: ${configured.id}-ok. Do not use tools. Do not edit files.`,
    agent_ids: [configured.id],
    cwd: repoRoot,
    timeout_ms: options.timeoutMs ?? 120_000,
  });
  result.ping = {
    status: ping.status,
    summary: ping.summary,
    session_id: ping.session_id,
    native_session_id: ping.native_session_id,
  };
  result.verified = ping.status === 'completed';
  result.summary = ping.summary;
  return result;
}

export async function verifyWorker(options) {
  const repoRoot = resolve(options.repoRoot ?? repoRootFromScript);
  const configPath = resolve(options.config ?? join(repoRoot, 'config', 'agents.local.json'));
  const broker = new AgentBroker(configPath);
  const listed = await broker.listAgents({ refresh: true });
  const probe = listed.agents.find((agent) => agent.id === options.agentId);
  const result = {
    agent_id: options.agentId,
    model: options.model,
    probe,
    verified: false,
  };
  if (probe?.status !== 'available') {
    result.summary = probe?.reason ?? `${options.agentId} is not available.`;
    return result;
  }

  const ping = await broker.delegate({
    task: 'Reply exactly: OK',
    agent_ids: [options.agentId],
    difficulty: options.difficulty,
    cwd: repoRoot,
    timeout_ms: options.timeoutMs ?? 30_000,
  });
  result.ping = {
    status: ping.status,
    summary: ping.summary,
  };
  result.verified = ping.status === 'completed';
  result.summary = ping.summary;
  return result;
}

function usage() {
  return `Usage:
  npm run connect                  # fullscreen TUI; loops until q
  node bin/connect-worker.js --cli <command>
  node bin/connect-worker.js --cli <command> --model <id>
  node bin/connect-worker.js --list-clis
`;
}

const NO_COLOR = Boolean(process.env.NO_COLOR);
const TRUECOLOR = /\btruecolor\b/i.test(process.env.COLORTERM || '')
  || process.env.COLORTERM === '24bit';

function sgr(code) {
  if (NO_COLOR) return '';
  return TRUECOLOR ? code.truecolor : code.ansi;
}

const palette = {
  canvas: { truecolor: '\x1b[48;2;255;255;255m\x1b[38;2;15;23;42m', ansi: '\x1b[47m\x1b[30m' },
  accent: { truecolor: '\x1b[38;2;29;78;216m', ansi: '\x1b[34m' },
  dim: { truecolor: '\x1b[38;2;100;116;139m', ansi: '\x1b[90m' },
  selected: { truecolor: '\x1b[48;2;29;78;216m\x1b[38;2;255;255;255m', ansi: '\x1b[44m\x1b[97m' },
  error: { truecolor: '\x1b[38;2;185;28;28m', ansi: '\x1b[31m' },
};

const canvas = () => sgr(palette.canvas);

function paint(code, text) {
  if (NO_COLOR) return text;
  return `${sgr(code)}${text}${canvas()}`;
}

const theme = {
  accent: (text) => paint(palette.accent, text),
  dim: (text) => paint(palette.dim, text),
  success: (text) => paint(palette.accent, text),
  error: (text) => paint(palette.error, text),
  selected: (text) => paint(palette.selected, text),
};

function visLen(text) {
  return [...String(text).replace(/\x1b\[[0-9;]*m/g, '')].length;
}

function ellipsize(text, width) {
  const chars = [...String(text)];
  if (width <= 0) return '';
  if (chars.length <= width) return text;
  if (width === 1) return '…';
  return `${chars.slice(0, width - 1).join('')}…`;
}

export function wrapText(text, width) {
  if (width <= 0) return [];
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    if (!line) {
      line = word;
    } else if (visLen(`${line} ${word}`) <= width) {
      line += ` ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function displayPath(filePath) {
  const home = homedir();
  if (filePath?.startsWith(home)) return `~${filePath.slice(home.length)}`;
  return filePath ?? '';
}

export function mapKeypress(str, key = {}) {
  if (key.ctrl && key.name === 'c') return 'ctrl-c';
  if (key.ctrl && key.name === 'u') return 'ctrl-u';
  if (key.name === 'escape') return 'esc';
  if (key.name === 'backspace') return 'backspace';
  if (key.name === 'tab') return 'tab';
  if (key.name === 'return' || key.name === 'enter') return 'enter';
  if (key.name === 'up' || key.name === 'down' || key.name === 'home' || key.name === 'end'
    || key.name === 'pageup' || key.name === 'pagedown') {
    return key.name;
  }
  if (key.ctrl || key.meta) return undefined;
  if (typeof str === 'string' && str.length > 0 && str !== '\x1b' && !str.startsWith('\x1b')) {
    return str;
  }
  return undefined;
}

function screenBackground() {
  return canvas();
}

function createScreen() {
  let inFd;
  let outFd;
  try {
    inFd = openSync('/dev/tty', 'r');
    outFd = openSync('/dev/tty', 'w');
  } catch {
    throw new Error('Interactive UI needs a real terminal. Run `npm run connect` in a TTY.');
  }
  const input = new tty.ReadStream(inFd);
  const output = new tty.WriteStream(outFd);
  let keyHandler = null;
  let raw = false;

  const write = (data) => {
    writeSync(outFd, data);
  };
  const onKeypress = (str, key) => {
    const mapped = mapKeypress(str, key ?? {});
    if (mapped) keyHandler?.(mapped);
  };
  const onResize = () => keyHandler?.('resize');

  return {
    enter() {
      write(`\x1b[?1049h\x1b[?47h\x1b[?7l\x1b[3J\x1b[2J\x1b[H\x1b[0m${canvas()}`);
      readline.emitKeypressEvents(input);
      input.setRawMode(true);
      raw = true;
      input.resume();
      input.on('keypress', onKeypress);
      output.on('resize', onResize);
      process.on('SIGWINCH', onResize);
    },
    leave() {
      process.off('SIGWINCH', onResize);
      input.off('keypress', onKeypress);
      output.off('resize', onResize);
      if (raw) {
        try {
          input.setRawMode(false);
        } catch {
          // TTY may already be closed.
        }
      }
      write('\x1b[0m\x1b[?25h\x1b[?7h\x1b[2J\x1b[H\x1b[?47l\x1b[?1049l');
      input.destroy();
      output.destroy();
    },
    size() {
      return {
        cols: Math.max(40, output.columns || process.stdout.columns || 80),
        rows: Math.max(12, output.rows || process.stdout.rows || 24),
      };
    },
    paint(lines, cursor) {
      const { cols, rows } = this.size();
      const bg = screenBackground();
      const chunks = ['\x1b[?7l\x1b[H'];
      for (let index = 0; index < rows; index += 1) {
        const line = lines[index] ?? '';
        const extra = Math.max(0, cols - visLen(line));
        chunks.push(`\x1b[${index + 1};1H\x1b[2K${bg}${line}${' '.repeat(extra)}`);
      }
      write(chunks.join(''));
      if (cursor) {
        write(`\x1b[${cursor.row};${cursor.col}H\x1b[?25h`);
      } else {
        write('\x1b[?25l');
      }
    },
    onKey(handler) {
      keyHandler = handler;
      return () => {
        if (keyHandler === handler) keyHandler = null;
      };
    },
  };
}

function titleLine(title, meta, width) {
  const left = ` ${title}`;
  const right = meta ? `${meta} ` : '';
  const gap = Math.max(1, width - visLen(left) - visLen(right));
  return `${theme.accent(left)}${' '.repeat(gap)}${theme.dim(right)}`;
}

function listRow(row, selected, width) {
  const inner = width - 1;
  const meta = row.meta ?? '';
  const metaWidth = Math.min(visLen(meta), Math.max(8, Math.floor(inner * 0.42)));
  const metaShown = ellipsize(meta, metaWidth);
  const detail = row.detail ? ` · ${row.detail}` : '';
  const leftBudget = inner - 1 - visLen(metaShown) - (metaShown ? 2 : 0);
  const leftShown = ellipsize(`${row.title}${detail}`, Math.max(2, leftBudget));
  const pad = Math.max(1, inner - visLen(leftShown) - visLen(metaShown));
  const body = ` ${leftShown}${' '.repeat(pad)}${metaShown}`;
  if (selected) return theme.selected(body);
  return ` ${theme.dim(leftShown)}${' '.repeat(pad)}${theme.dim(metaShown)}`;
}

function promptBox(label, text, width, tone = 'accent', { placeholder = false } = {}) {
  const inner = width - 2;
  const color = tone === 'error' ? theme.error : tone === 'success' ? theme.success : theme.accent;
  const prefix = '❯ ';
  const room = Math.max(1, inner - 2 - visLen(prefix));
  const raw = ellipsize(text, room);
  const body = `${prefix}${placeholder ? theme.dim(raw) : raw}`;
  const midPad = Math.max(0, inner - 2 - visLen(body));
  const labelText = `─ ${label} `;
  const bottomFill = Math.max(0, inner - visLen(labelText));
  return [
    color(`╭${'─'.repeat(inner)}╮`),
    `${color('│')} ${body}${' '.repeat(midPad)} ${color('│')}`,
    color(`╰${labelText}${'─'.repeat(bottomFill)}╯`),
  ];
}

export function filterRows(rows, query) {
  const needle = query.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((row) => (
    `${row.title} ${row.detail ?? ''} ${row.meta ?? ''} ${row.value ?? ''}`.toLowerCase().includes(needle)
  ));
}

function completionRow(item, selected, width) {
  const shown = ellipsize(` ${item.title}`, Math.max(2, width - 1));
  return selected ? theme.selected(shown) : theme.accent(shown);
}

function renderFrame({
  title,
  meta,
  rows = [],
  selected = 0,
  busy,
  boxLabel,
  boxText,
  boxTone,
  footer,
  query,
  placeholder,
  allowInput,
  completions = [],
  completionSelected = 0,
}) {
  const screen = renderFrame.screen;
  const { cols, rows: height } = screen.size();
  const menu = completions.slice(0, Math.min(6, completions.length));
  const menuHeight = menu.length;
  const description = !busy ? rows[selected]?.description : undefined;
  const descriptionLines = description
    ? wrapText(description, Math.max(1, cols - 2))
    : [];
  const listBudget = Math.max(1, height - 6 - menuHeight - descriptionLines.length);
  const lines = [titleLine(title, meta, cols), ''];

  if (busy) {
    lines.push(` ${theme.accent(busy)}`);
    while (lines.length < 2 + listBudget) lines.push('');
  } else {
    let start = 0;
    if (rows.length > listBudget) {
      start = Math.min(
        Math.max(0, selected - Math.floor(listBudget / 2)),
        rows.length - listBudget,
      );
    }
    const end = Math.min(rows.length, start + listBudget);
    for (let index = start; index < end; index += 1) {
      lines.push(listRow(rows[index], !menu.length && index === selected, cols));
    }
    while (lines.length < 2 + listBudget) lines.push('');
  }

  for (const line of descriptionLines) lines.push(theme.dim(` ${line}`));

  if (menu.length) {
    for (const [index, item] of menu.entries()) {
      lines.push(completionRow(item, index === completionSelected, cols));
    }
  }

  const emptyQuery = !(query ?? '');
  const promptText = allowInput
    ? (emptyQuery ? (placeholder || boxText) : query)
    : boxText;
  lines.push(...promptBox(boxLabel, promptText, cols, boxTone, {
    placeholder: Boolean(allowInput && emptyQuery),
  }));
  lines.push(theme.dim(` ${footer}`));
  const promptRow = 2 + listBudget + descriptionLines.length + menuHeight + 2;
  const prefixCols = 2 + visLen('❯ ');
  const cursorCol = prefixCols + visLen(allowInput && !emptyQuery ? query : '');
  return {
    lines: lines.slice(0, height),
    cursor: allowInput && !busy
      ? { row: promptRow, col: Math.min(cols - 1, cursorCol) }
      : undefined,
  };
}

async function pickFromList(screen, view) {
  return new Promise((resolve, reject) => {
    let selected = Math.max(0, view.initialSelected ?? 0);
    let completionSelected = 0;
    let query = '';
    const visible = () => {
      if (query.startsWith('/')) return view.rows;
      return view.allowInput ? filterRows(view.rows, query) : view.rows;
    };
    const completions = () => slashCompletions(query, view.slash?.commands ?? []);
    const draw = () => {
      const rows = visible();
      const menu = completions();
      if (selected >= rows.length) selected = Math.max(0, rows.length - 1);
      if (completionSelected >= menu.length) completionSelected = Math.max(0, menu.length - 1);
      renderFrame.screen = screen;
      const frame = renderFrame({
        ...view,
        rows,
        selected,
        query,
        allowInput: view.allowInput,
        placeholder: view.placeholder,
        completions: menu,
        completionSelected,
      });
      screen.paint(frame.lines, frame.cursor);
    };
    const acceptCompletion = (submit) => {
      const menu = completions();
      const item = menu[completionSelected];
      if (!item) return false;
      query = item.insert;
      completionSelected = 0;
      if (submit && item.complete) return 'submit';
      draw();
      return true;
    };
    const off = screen.onKey((key) => {
      const rows = visible();
      const menu = completions();
      if (key === 'resize') {
        draw();
        return;
      }
      if (key === 'ctrl-c') {
        off();
        const error = new Error('Cancelled.');
        error.code = 'SIGINT';
        reject(error);
        return;
      }
      if (key === 'esc') {
        if (view.allowInput && query) {
          query = '';
          selected = 0;
          draw();
          return;
        }
        off();
        resolve(null);
        return;
      }
      if (view.allowInput && key === 'backspace') {
        query = query.slice(0, -1);
        selected = 0;
        completionSelected = 0;
        draw();
        return;
      }
      if (view.allowInput && key === 'ctrl-u') {
        query = '';
        selected = 0;
        completionSelected = 0;
        draw();
        return;
      }
      if (key === 'tab' && view.allowInput) {
        acceptCompletion(false);
        return;
      }
      if (key === 'enter') {
        if (menu.length && acceptCompletion(true) === true) return;
        const typed = query.trim();
        if (typed.startsWith('/')) {
          const slash = parseSlashCommand(typed);
          if (slash?.name === 'add' && !slash.argument) {
            query = '/add ';
            draw();
            return;
          }
          if (slash?.name === 'delete' && !slash.argument) {
            query = '/delete ';
            draw();
            return;
          }
          off();
          resolve({ slash, selected: rows[selected] });
          return;
        }
        if (typed && rows[selected]) {
          off();
          resolve(rows[selected]);
          return;
        }
        if (typed) {
          off();
          resolve({ error: view.usageAdd ?? `Use /add ${typed}` });
          return;
        }
        if (rows[selected]) {
          off();
          resolve(rows[selected]);
        }
        return;
      }
      if (key === 'up') {
        if (menu.length) completionSelected = (completionSelected + menu.length - 1) % menu.length;
        else selected = rows.length ? (selected + rows.length - 1) % rows.length : 0;
      } else if (key === 'down') {
        if (menu.length) completionSelected = (completionSelected + 1) % menu.length;
        else selected = rows.length ? (selected + 1) % rows.length : 0;
      } else if (key === 'home') selected = 0;
      else if (key === 'end') selected = Math.max(0, rows.length - 1);
      else if (key === 'pageup') selected = Math.max(0, selected - 10);
      else if (key === 'pagedown') selected = Math.min(Math.max(0, rows.length - 1), selected + 10);
      else if (view.allowInput && key.length >= 1 && !['up', 'down', 'home', 'end', 'pageup', 'pagedown', 'resize', 'tab'].includes(key)) {
        query += key;
        if (query.startsWith('/')) completionSelected = 0;
        else selected = 0;
      } else if (!view.allowInput && (key === 'k' || key === 'j' || key === 'g' || key === 'G' || key === 'q')) {
        if (key === 'q') {
          off();
          resolve(null);
          return;
        }
        if (key === 'k') selected = rows.length ? (selected + rows.length - 1) % rows.length : 0;
        if (key === 'j') selected = rows.length ? (selected + 1) % rows.length : 0;
        if (key === 'g') selected = 0;
        if (key === 'G') selected = Math.max(0, rows.length - 1);
      }
      draw();
    });
    draw();
  });
}

async function withBusy(screen, message, work, view) {
  const frames = ['⋅', ':', '⸬', '⁙'];
  let frame = 0;
  renderFrame.screen = screen;
  const tick = () => {
    const painted = renderFrame({
      ...view,
      rows: [],
      busy: `${frames[frame % frames.length]}  ${message}`,
    });
    screen.paint(painted.lines);
    frame += 1;
  };
  tick();
  const timer = setInterval(tick, 90);
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}

export async function pickDifficulty(screen, agentId, model) {
  const selected = await pickFromList(screen, {
    title: `${agentId} · add route`,
    meta: model,
    rows: TASK_DIFFICULTIES.map((difficulty) => ({
      title: difficulty.title,
      description: difficulty.description,
      value: difficulty.value,
    })),
    boxLabel: 'task difficulty',
    boxText: 'Choose the kind of task this route should handle.',
    boxTone: 'accent',
    allowInput: false,
    footer: '↑/↓  ·  Enter select  ·  Esc back',
  });
  return selected?.value;
}

export async function pickModelAction(screen, route) {
  const selected = await pickFromList(screen, {
    title: `${route.model} · actions`,
    meta: `${route.value} · ${taskDifficulty(route.difficulty).title}`,
    rows: [
      {
        title: 'Verify',
        detail: 'send a short connection check',
        value: 'verify',
      },
      {
        title: 'Delete route',
        detail: 'remove this model route',
        value: 'delete',
      },
      {
        title: 'Back',
        detail: 'return to models',
        value: 'back',
      },
    ],
    boxLabel: 'action',
    boxText: 'Choose an action.',
    boxTone: 'accent',
    allowInput: false,
    footer: '↑/↓  ·  Enter select  ·  Esc back',
  });
  return selected?.value ?? 'back';
}

export function formatVerificationResult(route, verification) {
  if (verification.verified) {
    return `Verified ${route.model} (${route.value} · ${taskDifficulty(route.difficulty).title}).`;
  }
  return `Verification failed for ${route.model}: ${verification.summary ?? 'Unknown error.'}`;
}

export async function showVerificationResult(screen, route, verification) {
  await pickFromList(screen, {
    title: `${route.model} · verification`,
    meta: verification.verified ? 'success' : 'failed',
    rows: [{
      title: verification.verified ? 'Connected' : 'Connection failed',
      description: verification.summary ?? '',
      value: 'close',
    }],
    boxLabel: 'result',
    boxText: formatVerificationResult(route, verification),
    boxTone: verification.verified ? 'success' : 'error',
    allowInput: false,
    footer: 'Enter or Esc close',
  });
}

function printOneShot(result) {
  process.stdout.write(`${JSON.stringify({
    agent_id: result.agent_id,
    command: result.command,
    model: result.model,
    routes: result.routes,
    config: result.configPath,
    probe: result.probe?.status ?? null,
    ping: result.ping?.status ?? null,
    summary: result.summary ?? null,
    verified: result.verified ?? null,
  }, null, 2)}\n`);
}

async function runInteractiveLoop(baseOptions) {
  const screen = createScreen();
  screen.enter();
  let boxText = 'Use /add <service> <model> <effort> to assign a route.';
  let boxTone = 'accent';
  try {
    for (;;) {
      const { catalog } = await connectWorker({ ...baseOptions, listClis: true, verify: false });
      const rows = modelRows(catalog);
      const worker = await pickFromList(screen, {
        title: 'agent-broker · Connect',
        meta: `${catalog.length} worker${catalog.length === 1 ? '' : 's'}`,
        rows,
        boxLabel: 'connect',
        boxText,
        boxTone,
        allowInput: true,
        placeholder: '/add <service> <model> <effort>  ·  /delete <service> <model> <effort>',
        footer: '↑/↓  ·  Enter actions  ·  Tab complete  ·  /add  ·  /delete  ·  Esc quit',
        usageAdd: 'Use /add <service> <model> <effort>',
        slash: {
          commands: [
            {
              name: 'add',
              hint: '<service> <model> <effort>',
              complete: (insert) => Boolean(parseWorkerRouteInput(parseSlashCommand(insert)?.argument)),
            },
            {
              name: 'delete',
              hint: '<service> <model> <effort>',
              complete: (insert) => Boolean(parseWorkerRouteInput(parseSlashCommand(insert)?.argument)),
              arguments: (head) => {
                if (head.length === 0) return catalog.map((agent) => agent.id);
                const agent = catalog.find((candidate) => candidate.id === head[0]);
                const routes = routesFrom(agent);
                if (head.length === 1) return [...new Set(routes.map((route) => route.model))];
                const model = head.slice(1).join(' ');
                return [...new Set(routes
                  .filter((route) => route.model === model && route.effort)
                  .map((route) => route.effort))];
              },
            },
          ],
        },
      });
      if (!worker) return;
      if (worker.error) {
        boxText = worker.error;
        boxTone = 'error';
        continue;
      }

      if (worker.slash) {
        if (worker.slash.unknown) {
          boxText = `Unknown command /${worker.slash.name}`;
          boxTone = 'error';
          continue;
        }
        if (worker.slash.name === 'delete') {
          const removal = parseWorkerRouteInput(worker.slash.argument);
          if (!removal) {
            boxText = 'Usage: /delete <service> <model> <effort>';
            boxTone = 'error';
            continue;
          }
          try {
            await connectWorker({
              ...baseOptions,
              cli: removal.service,
              removeRoute: { model: removal.model, effort: removal.effort },
              verify: false,
            });
          } catch (error) {
            boxText = error instanceof Error ? error.message : String(error);
            boxTone = 'error';
            continue;
          }
          boxText = `Removed ${removal.service} ${removal.model} · effort:${removal.effort}`;
          boxTone = 'success';
          continue;
        }
        if (worker.slash.name !== 'add') {
          boxText = `Unknown command /${worker.slash.name}`;
          boxTone = 'error';
          continue;
        }
        const registration = parseWorkerRouteInput(worker.slash.argument);
        if (!registration) {
          boxText = 'Usage: /add <service> <model> <effort>';
          boxTone = 'error';
          continue;
        }
      }

      const registration = worker.slash?.name === 'add'
        ? parseWorkerRouteInput(worker.slash.argument)
        : undefined;
      if (!registration) {
        if (!worker.model) {
          boxText = `Use /add ${worker.value} <model> <effort>.`;
          boxTone = 'accent';
          continue;
        }
        const action = await pickModelAction(screen, worker);
        if (action === 'back') continue;
        if (action === 'delete') {
          try {
            await connectWorker({
              ...baseOptions,
              cli: worker.value,
              removeRoute: { model: worker.model, effort: worker.effort },
              verify: false,
            });
          } catch (error) {
            boxText = error instanceof Error ? error.message : String(error);
            boxTone = 'error';
            continue;
          }
          boxText = `Removed ${worker.value} ${worker.model}${worker.effort
            ? ` · effort:${worker.effort}`
            : ''}`;
          boxTone = 'success';
          continue;
        }
        let verification;
        try {
          verification = await withBusy(
            screen,
            `verifying ${worker.model}…`,
            () => verifyWorker({
              ...baseOptions,
              agentId: worker.value,
              difficulty: worker.difficulty,
              model: worker.model,
            }),
            {
              title: 'agent-broker · Verify',
              meta: worker.model,
              boxLabel: 'verify',
              boxText: `Verifying ${worker.model}…`,
              boxTone: 'accent',
              footer: 'please wait',
            },
          );
        } catch (error) {
          verification = {
            verified: false,
            summary: error instanceof Error ? error.message : String(error),
          };
        }
        await showVerificationResult(screen, worker, verification);
        boxText = 'Choose a model or use a command.';
        boxTone = 'accent';
        continue;
      }
      const token = registration.service;
      const difficulty = await pickDifficulty(screen, token, registration.model);
      if (!difficulty) {
        boxText = 'Add cancelled.';
        boxTone = 'accent';
        continue;
      }
      const assignment = {
        model: registration.model,
        effort: registration.effort,
        difficulty,
      };
      let connected;
      try {
        connected = await withBusy(
          screen,
          `connecting ${token}…`,
          () => connectWorker({
            ...baseOptions,
            cli: token,
            setRoute: assignment,
            verify: 'probe',
          }),
          {
            title: 'agent-broker · Connect',
            meta: token,
            boxLabel: 'connect',
            boxText: `Connecting ${token}…`,
            boxTone: 'accent',
            footer: 'please wait',
          },
        );
      } catch (error) {
        boxText = error instanceof Error ? error.message : String(error);
        boxTone = 'error';
        continue;
      }
      if (connected.probe?.status !== 'available') {
        boxText = `${token} is not available.`;
        boxTone = 'error';
        continue;
      }

      boxText = `${connected.agent_id}  ${formatRouteAssignment(assignment)}`;
      boxTone = 'success';
    }
  } finally {
    screen.leave();
  }
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write(usage());
    return;
  }

  if (options.listClis) {
    const { catalog } = await connectWorker(options);
    process.stdout.write(`${JSON.stringify(catalog.map((agent) => ({
      id: agent.id,
      label: agent.label ?? agent.id,
      command: agent.command,
    })), null, 2)}\n`);
    return;
  }

  const tty = process.stdin.isTTY && process.stdout.isTTY;
  if (tty && options.model === undefined) {
    await runInteractiveLoop(options);
    return;
  }

  if (!options.cli) {
    throw new TypeError('Pass --cli <id> or run in a terminal for the interactive UI.');
  }

  const result = await connectWorker(options);
  printOneShot(result);
  if (result.written && result.verified === false) process.exitCode = 1;
}

const invokedDirectly = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  main().catch((error) => {
    if (error?.code === 'SIGINT') {
      process.exitCode = 0;
      return;
    }
    process.stderr.write(`connect-worker: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
