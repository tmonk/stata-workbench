#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

let Client;
let StdioClientTransport;
let LoggingMessageNotificationSchema;

try {
  ({ Client } = require('@modelcontextprotocol/sdk/client'));
  ({ StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js'));
  try {
    ({ LoggingMessageNotificationSchema } = require('@modelcontextprotocol/sdk/types'));
  } catch (_err) {
    ({ LoggingMessageNotificationSchema } = require('@modelcontextprotocol/sdk/types.js'));
  }
} catch (err) {
  console.error('Failed to load MCP SDK. Did you run npm install?');
  console.error(err);
  process.exit(1);
}

const argv = process.argv.slice(2);
let commandOverride = null;
let argsOverride = null;
let codeOverride = null;
let skipRun = false;

for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === '--command') {
    commandOverride = argv[i + 1];
    i += 1;
  } else if (arg === '--args') {
    argsOverride = (argv[i + 1] || '').split(' ').filter(Boolean);
    i += 1;
  } else if (arg === '--code') {
    codeOverride = argv[i + 1];
    i += 1;
  } else if (arg === '--no-run') {
    skipRun = true;
  }
}

function resolveTransportConfig() {
  if (commandOverride) {
    return { command: commandOverride, args: argsOverride || [] };
  }

  const localRepo = process.env.MCP_STATA_LOCAL_REPO;
  if (localRepo && fs.existsSync(localRepo)) {
    return {
      command: 'uv',
      args: ['run', '--directory', localRepo, 'mcp-stata']
    };
  }

  const uvx = process.env.MCP_STATA_UVX_CMD || 'uvx';
  const pkgSpec = process.env.MCP_STATA_PACKAGE_SPEC || 'mcp-stata@latest';
  return {
    command: uvx,
    args: ['--from', pkgSpec, 'mcp-stata']
  };
}

function extractText(response) {
  if (typeof response === 'string') return response;
  if (response?.text && typeof response.text === 'string') return response.text;
  if (Array.isArray(response?.content)) {
    return response.content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object' && typeof item.text === 'string') return item.text;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (response?.structuredContent?.result && typeof response.structuredContent.result === 'string') {
    return response.structuredContent.result;
  }
  return '';
}

function tryParseJson(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    return JSON.parse(trimmed);
  } catch (_err) {
    return null;
  }
}

function extractTaskId(response) {
  if (!response) return null;
  const direct = response?.task_id || response?.taskId || response?.structuredContent?.task_id;
  if (typeof direct === 'string' && direct.trim()) return direct;
  const text = extractText(response);
  const parsed = tryParseJson(text);
  const taskId = parsed?.task_id || parsed?.taskId || parsed?.error?.task_id || parsed?.error?.taskId;
  if (typeof taskId === 'string' && taskId.trim()) return taskId;
  return null;
}

function extractLogPath(response) {
  if (!response) return null;
  const direct = response?.log_path || response?.logPath || response?.structuredContent?.log_path;
  if (typeof direct === 'string' && direct.trim()) return direct;
  const text = extractText(response);
  const parsed = tryParseJson(text);
  const logPath = parsed?.log_path || parsed?.logPath || parsed?.error?.log_path || parsed?.error?.logPath;
  if (typeof logPath === 'string' && logPath.trim()) return logPath;
  return null;
}

async function main() {
  const { command, args } = resolveTransportConfig();
  console.log('[mcp-log-watch] stage: resolve-transport');
  console.log(`[mcp-log-watch] command: ${command}`);
  console.log(`[mcp-log-watch] args: ${JSON.stringify(args)}`);

  console.log('[mcp-log-watch] stage: create-transport');
  const transport = new StdioClientTransport({
    command,
    args,
    stderr: 'pipe',
    cwd: process.cwd(),
    env: {
      ...process.env,
      PYTHONUNBUFFERED: '1'
    }
  });

  if (transport.stderr && typeof transport.stderr.on === 'function') {
    transport.stderr.setEncoding?.('utf8');
    transport.stderr.on('data', (chunk) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (text.trim()) {
        console.log(`[mcp-log-watch] stderr: ${text.trimEnd()}`);
      }
    });
  }

  const client = new Client({ name: 'mcp-log-watch', version: '0.1.0' });
  const pending = new Map();

  if (LoggingMessageNotificationSchema) {
    client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
      const text = String(notification?.params?.data ?? '');
      if (!text) return;
      console.log(`[logMessage] ${text}`);
      const parsed = tryParseJson(text);
      if (parsed && typeof parsed === 'object') {
        const event = parsed.event || 'unknown';
        console.log(`[event:${event}]`, parsed);
        const taskId = parsed.task_id || parsed.taskId;
        if (taskId && pending.has(taskId)) {
          if (event === 'tool_error') {
            const reject = pending.get(taskId);
            pending.delete(taskId);
            reject(new Error(parsed.error || 'tool_error'));
            return;
          }
          const resolve = pending.get(taskId);
          pending.delete(taskId);
          resolve(parsed);
        }
      }
    });
  }

  console.log('[mcp-log-watch] stage: connect');
  await client.connect(transport);
  console.log('[mcp-log-watch] stage: connected');

  console.log('[mcp-log-watch] stage: list-tools');
  const tools = await client.listTools();
  console.log('[mcp-log-watch] tools:', tools);

  if (skipRun) {
    console.log('[mcp-log-watch] stage: idle');
    console.log('[mcp-log-watch] Connected. Waiting for notifications...');
    await new Promise(() => {});
    return;
  }

  const code = codeOverride || 'sysuse auto, clear\ntwoway scatter mpg weight';
  console.log('[mcp-log-watch] stage: call-tool run_command_background');
  console.log(`[mcp-log-watch] code:\n${code}`);
  const kickoff = await client.callTool({
    name: 'run_command_background',
    arguments: {
      code,
      echo: true,
      as_json: true,
      trace: false
    }
  });

  console.log('[mcp-log-watch] stage: kickoff-response');
  console.log('[mcp-log-watch] kickoff:', kickoff);
  const taskId = extractTaskId(kickoff);
  const logPath = extractLogPath(kickoff);
  if (logPath) {
    console.log(`[mcp-log-watch] log_path: ${logPath}`);
  }

  if (!taskId) {
    console.log('[mcp-log-watch] stage: missing-task-id');
    console.log('[mcp-log-watch] No task_id found in kickoff response.');
    return;
  }

  console.log(`[mcp-log-watch] stage: wait-task-done (${taskId})`);
  const payload = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(taskId);
      reject(new Error(`Timed out waiting for task_done for ${taskId}`));
    }, 30000);
    pending.set(taskId, (dataOrError) => {
      clearTimeout(timeout);
      if (dataOrError instanceof Error) {
        reject(dataOrError);
      } else {
        resolve(dataOrError);
      }
    });
  });

  console.log('[mcp-log-watch] stage: task-done');
  console.log('[mcp-log-watch] task_done payload:', payload);
}

main().catch((err) => {
  console.error('[mcp-log-watch] failed', err);
  process.exit(1);
});
