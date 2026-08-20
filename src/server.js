import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { AgentBroker } from './index.js';

export function createServer(broker) {
  const server = new McpServer({ name: 'agent-broker', version: '0.1.0' });

  server.registerTool(
    'list_agents',
    {
      title: 'List available coding agents',
      description: 'Return local subscription-agent availability, roles, scarcity, and continuation support.',
      inputSchema: { refresh: z.boolean().optional() },
    },
    async (input) => asToolResult(await broker.listAgents(input)),
  );

  server.registerTool(
    'delegate',
    {
      title: 'Delegate bounded coding work',
      description: 'Run a task through subscription-backed native CLI agents, optionally routed by task difficulty.',
      inputSchema: {
        task: z.string().min(1),
        cwd: z.string().min(1).optional(),
        role: z.string().min(1).optional(),
        difficulty: z.enum(['easy_task', 'standard_task', 'hard_task']).optional(),
        agent_ids: z.array(z.string().min(1)).min(1).optional(),
        retry_safe: z.boolean().optional(),
        timeout_ms: z.number().int().positive().max(3_600_000).optional(),
      },
    },
    async (input) => asToolResult(await broker.delegate(input)),
  );

  server.registerTool(
    'continue',
    {
      title: 'Continue a delegated native session',
      description: 'Resume the exact native session recorded by a previous delegation.',
      inputSchema: {
        session_id: z.string().min(1),
        task: z.string().min(1),
        timeout_ms: z.number().int().positive().max(3_600_000).optional(),
      },
    },
    async (input) => asToolResult(await broker.continue(input)),
  );

  return server;
}

export async function startServer({ configPath }) {
  if (!configPath) throw new TypeError('agent-broker requires --config <path>.');
  const broker = new AgentBroker(configPath);
  const server = createServer(broker);
  await server.connect(new StdioServerTransport());
  return { broker, server };
}

function asToolResult(result) {
  const isError = Boolean(result?.status && result.status !== 'completed');
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: result,
    ...(isError ? { isError: true } : {}),
  };
}
