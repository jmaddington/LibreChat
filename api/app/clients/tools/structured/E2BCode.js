const { z } = require('zod');
const { Tool } = require('@langchain/core/tools');
const { getEnvironmentVariable } = require('@langchain/core/utils/env');
const { Sandbox } = require('@e2b/code-interpreter');
const { logger } = require('~/config');

// Store active sandboxes with their session IDs
const sandboxes = new Map();

class E2BCode extends Tool {
  constructor(fields = {}) {
    super();
    const envVar = 'E2B_API_KEY';
    const override = fields.override ?? false;
    this.apiKey = fields.apiKey ?? this.getApiKey(envVar, override);
    const keySuffix = this.apiKey ? this.apiKey.slice(-5) : 'none';
    logger.debug(
      '[E2BCode] Initialized with API key ' + `*****${keySuffix}`
    );
    this.name = 'E2BCode';
    this.description =
      `Use E2B to execute code, shell commands, manage files, install packages, and manage sandbox environments in an isolated sandbox.

      **Important:** You must provide a unique 'sessionId' string to maintain session state between calls.

      You can set environment variables when creating the sandbox and during code or command execution using the 'envs' parameter.

      For example, to create a sandbox with an environment variable:

      Action: 'create', envs: { "MY_VAR": "my_value" }

      To execute code with an environment variable:

      Action: 'execute', code: 'import os; print(os.environ.get("MY_VAR"))', envs: { "MY_VAR": "my_value" }

      To change the timeout of an existing sandbox:

      Action: 'set_timeout', timeout: 120
      `;
    this.schema = z.object({
      sessionId: z
        .string()
        .min(1)
        .describe(
          'A unique identifier for the session. Use the same `sessionId` to maintain state across multiple calls.'
        ),
      action: z
        .enum([
          'create',
          'list_sandboxes',
          'kill',
          'set_timeout', // Added 'set_timeout' action
          'execute',
          'shell',
          'kill_command',
          'write_file',
          'read_file',
          'install',
          'get_file_downloadurl',
          'get_host',
        ])
        .describe(
          'The action to perform: create a new sandbox, list running sandboxes, kill a sandbox, change sandbox timeout, execute code, run shell command, kill a background command, write file, read file, install package, get file download URL, or get the host and port.'
        ),
      code: z
        .string()
        .optional()
        .describe(
          'The code to execute or package to install (required for `execute` and `install` actions).'
        ),
      language: z
        .enum(['python', 'javascript', 'typescript', 'shell'])
        .optional()
        .describe('The programming language to use. Defaults to `python`.'),
      command: z
        .string()
        .optional()
        .describe('Shell command to execute (required for `shell` action).'),
      background: z
        .boolean()
        .optional()
        .describe(
          'Whether to run the shell command in the background (optional, used with `shell` action).'
        ),
      commandId: z
        .string()
        .optional()
        .describe(
          'The ID of the background command to kill (required for `kill_command` action).'
        ),
      filePath: z
        .string()
        .optional()
        .describe(
          'Path for read/write operations (required for `write_file`, `read_file`, and `get_file_downloadurl` actions).'
        ),
      fileContent: z
        .string()
        .optional()
        .describe(
          'Content to write to file (required for `write_file` action).'
        ),
      port: z
        .number()
        .int()
        .optional()
        .describe(
          'Port number to use for the host (required for `get_host` action).'
        ),
      timeout: z
        .number()
        .int()
        .optional()
        .describe(
          'Timeout in minutes for the sandbox environment. Defaults to 60 minutes.'
        ),
      envs: z
        .record(z.string(), z.string())
        .optional()
        .describe(
          'Environment variables to set when creating the sandbox (used with `create` action) and for specific execution (used with `execute`, `shell`, and `install` actions).'
        ),
    });
  }

  getApiKey(envVar, override) {
    const key = getEnvironmentVariable(envVar);
    if (!key && !override) {
      logger.error(`[E2BCode] Missing ${envVar} environment variable`);
      throw new Error(`Missing ${envVar} environment variable.`);
    }
    return key;
  }

  async _call(input) {
    const {
      sessionId,
      code,
      language = 'python',
      action,
      command,
      background = false,
      commandId,
      filePath,
      fileContent,
      port,
      timeout = 60,
      envs,
    } = input;

    if (!sessionId) {
      logger.error('[E2BCode] `sessionId` is missing in the input');
      throw new Error('`sessionId` is required to maintain session state.');
    }

    logger.debug('[E2BCode] Processing request', {
      action,
      language,
      sessionId,
    });

    try {
      if (action === 'create') {
        if (sandboxes.has(sessionId)) {
          logger.error('[E2BCode] Sandbox already exists', { sessionId });
          throw new Error(
            `Sandbox with sessionId ${sessionId} already exists.`
          );
        }
        logger.debug('[E2BCode] Creating new sandbox', {
          sessionId,
          timeout,
          envs,
        });
        const sandboxOptions = {
          apiKey: this.apiKey,
          timeoutMs: timeout * 60 * 1000,
        };
        if (envs) {
          sandboxOptions.env = envs;
        }
        const sandbox = await Sandbox.create(sandboxOptions);
        sandboxes.set(sessionId, {
          sandbox,
          lastAccessed: Date.now(),
          commands: new Map(),
        });
        return JSON.stringify({
          sessionId,
          success: true,
          message: `Sandbox created with timeout ${timeout} minutes.`,
        });
      }

      if (action === 'list_sandboxes') {
        if (sandboxes.size === 0) {
          logger.debug('[E2BCode] No active sandboxes found');
          return JSON.stringify({
            message: 'No active sandboxes found',
          });
        }
        return JSON.stringify({
          message: 'Active sandboxes found',
          sandboxes: Array.from(sandboxes.keys()),
        });
      }

      if (action === 'kill') {
        if (!sandboxes.has(sessionId)) {
          logger.error('[E2BCode] No sandbox found to kill', { sessionId });
          throw new Error(`No sandbox found with sessionId ${sessionId}.`);
        }
        logger.debug('[E2BCode] Killing sandbox', { sessionId });
        const { sandbox } = sandboxes.get(sessionId);
        await sandbox.kill();
        sandboxes.delete(sessionId);
        return JSON.stringify({
          sessionId,
          success: true,
          message: `Sandbox with sessionId ${sessionId} has been killed.`,
        });
      }

      // Handle 'set_timeout' action
      if (action === 'set_timeout') {
        if (!sandboxes.has(sessionId)) {
          logger.error('[E2BCode] No sandbox found to set timeout', {
            sessionId,
          });
          throw new Error(`No sandbox found with sessionId ${sessionId}.`);
        }
        if (!timeout) {
          logger.error(
            '[E2BCode] `timeout` is required for set_timeout action',
            { sessionId }
          );
          throw new Error('`timeout` is required for `set_timeout` action.');
        }
        logger.debug('[E2BCode] Setting sandbox timeout', {
          sessionId,
          timeout,
        });
        const { sandbox } = sandboxes.get(sessionId);
        await sandbox.setTimeout(timeout * 60 * 1000);
        return JSON.stringify({
          sessionId,
          success: true,
          message: `Sandbox timeout updated to ${timeout} minutes.`,
        });
      }

      const sandboxInfo = await this.getSandboxInfo(sessionId);
      const sandbox = sandboxInfo.sandbox;

      switch (action) {
        case 'execute':
          if (!code) {
            logger.error('[E2BCode] Code missing for execute action', {
              sessionId,
            });
            throw new Error('Code is required for `execute` action.');
          }
          logger.debug('[E2BCode] Executing code', {
            language,
            sessionId,
            envs,
          });
          const runCodeOptions = { language };
          if (envs) {
            runCodeOptions.envs = envs;
          }
          const result = await sandbox.runCode(code, runCodeOptions);
          logger.debug('[E2BCode] Code execution completed', {
            sessionId,
            hasError: !!result.error,
          });
          return JSON.stringify({
            sessionId,
            output: result.text,
            logs: result.logs,
            error: result.error,
          });

        case 'shell':
          if (!command) {
            logger.error('[E2BCode] Command missing for shell action', {
              sessionId,
            });
            throw new Error('Command is required for `shell` action.');
          }
          logger.debug('[E2BCode] Executing shell command', {
            sessionId,
            command,
            envs,
            background,
          });
          const shellOptions = {};
          if (envs) {
            shellOptions.envs = envs;
          }
          if (background) {
            shellOptions.background = true;
            const backgroundCommand = await sandbox.commands.run(
              command,
              shellOptions
            );
            const cmdId = backgroundCommand.id;
            sandboxInfo.commands.set(cmdId, backgroundCommand);
            logger.debug('[E2BCode] Background command started', {
              sessionId,
              commandId: cmdId,
            });
            return JSON.stringify({
              sessionId,
              commandId: cmdId,
              success: true,
              message: `Background command started with ID ${cmdId}`,
            });
          } else {
            const shellResult = await sandbox.commands.run(
              command,
              shellOptions
            );
            logger.debug('[E2BCode] Shell command completed', {
              sessionId,
              exitCode: shellResult.exitCode,
            });
            return JSON.stringify({
              sessionId,
              output: shellResult.stdout,
              error: shellResult.stderr,
              exitCode: shellResult.exitCode,
            });
          }

        case 'kill_command':
          if (!commandId) {
            logger.error(
              '[E2BCode] `commandId` missing for kill_command action',
              { sessionId }
            );
            throw new Error(
              '`commandId` is required for `kill_command` action.'
            );
          }
          logger.debug('[E2BCode] Killing background command', {
            sessionId,
            commandId,
          });
          const cmd = sandboxInfo.commands.get(commandId);
          if (!cmd) {
            logger.error('[E2BCode] No command found to kill', {
              sessionId,
              commandId,
            });
            throw new Error(
              `No background command found with ID ${commandId}.`
            );
          }
          await cmd.kill();
          sandboxInfo.commands.delete(commandId);
          return JSON.stringify({
            sessionId,
            success: true,
            message: `Background command with ID ${commandId} has been killed.`,
          });

        case 'write_file':
          if (!filePath || !fileContent) {
            logger.error(
              '[E2BCode] Missing parameters for write_file action',
              {
                sessionId,
                hasFilePath: !!filePath,
                hasContent: !!fileContent,
              }
            );
            throw new Error(
              '`filePath` and `fileContent` are required for `write_file` action.'
            );
          }
          logger.debug('[E2BCode] Writing file', { sessionId, filePath });
          await sandbox.files.write(filePath, fileContent);
          logger.debug('[E2BCode] File written successfully', {
            sessionId,
            filePath,
          });
          return JSON.stringify({
            sessionId,
            success: true,
            message: `File written to ${filePath}`,
          });

        case 'read_file':
          if (!filePath) {
            logger.error(
              '[E2BCode] `filePath` missing for read_file action',
              { sessionId }
            );
            throw new Error('`filePath` is required for `read_file` action.');
          }
          logger.debug('[E2BCode] Reading file', { sessionId, filePath });
          const content = await sandbox.files.read(filePath);
          logger.debug('[E2BCode] File read successfully', {
            sessionId,
            filePath,
          });
          return JSON.stringify({
            sessionId,
            content: content.toString(),
            success: true,
          });

        case 'install':
          if (!code) {
            logger.error(
              '[E2BCode] Package name missing for install action',
              {
                sessionId,
                language,
              }
            );
            throw new Error('Package name is required for `install` action.');
          }
          logger.debug('[E2BCode] Installing package', {
            sessionId,
            language,
            package: code,
            envs,
          });
          const installOptions = {};
          if (envs) {
            installOptions.envs = envs;
          }
          if (language === 'python') {
            const pipResult = await sandbox.commands.run(
              `pip install ${code}`,
              installOptions
            );
            logger.debug(
              '[E2BCode] Python package installation completed',
              {
                sessionId,
                success: pipResult.exitCode === 0,
              }
            );
            return JSON.stringify({
              sessionId,
              success: pipResult.exitCode === 0,
              output: pipResult.stdout,
              error: pipResult.stderr,
            });
          } else if (language === 'javascript' || language === 'typescript') {
            const npmResult = await sandbox.commands.run(
              `npm install ${code}`,
              installOptions
            );
            logger.debug(
              '[E2BCode] Node package installation completed',
              {
                sessionId,
                success: npmResult.exitCode === 0,
              }
            );
            return JSON.stringify({
              sessionId,
              success: npmResult.exitCode === 0,
              output: npmResult.stdout,
              error: npmResult.stderr,
            });
          }
          logger.error(
            '[E2BCode] Unsupported language for package installation',
            { sessionId, language }
          );
          throw new Error(
            `Unsupported language for package installation: ${language}`
          );

        case 'get_file_downloadurl':
          if (!filePath) {
            logger.error(
              '[E2BCode] `filePath` is required for get_file_downloadurl action',
              {
                sessionId,
              }
            );
            throw new Error(
              '`filePath` is required for `get_file_downloadurl` action.'
            );
          }
          logger.debug('[E2BCode] Generating download URL for file', {
            sessionId,
            filePath,
          });
          const downloadUrl = await sandbox.downloadUrl(filePath);
          logger.debug('[E2BCode] Download URL generated', {
            sessionId,
            filePath,
            downloadUrl,
          });
          return JSON.stringify({
            sessionId,
            success: true,
            downloadUrl,
            message: `Download URL generated for ${filePath}`,
          });

        case 'get_host':
          if (!port) {
            logger.error('[E2BCode] `port` is required for get_host action', {
              sessionId,
            });
            throw new Error('`port` is required for `get_host` action.');
          }
          logger.debug('[E2BCode] Getting host+port', { sessionId, port });
          const host = await sandbox.getHost(port);
          logger.debug('[E2BCode] Host+port retrieved', { sessionId, host });
          return JSON.stringify({
            sessionId,
            host,
            port,
            message: `Host+port retrieved for port ${port}`,
          });

        default:
          logger.error('[E2BCode] Unknown action requested', {
            sessionId,
            action,
          });
          throw new Error(`Unknown action: ${action}`);
      }
    } catch (error) {
      logger.error('[E2BCode] Error during execution', {
        sessionId,
        action,
        error: error.message,
      });
      return JSON.stringify({
        sessionId,
        error: error.message,
        success: false,
      });
    }
  }

  // Method to get an existing sandbox and its info based on sessionId
  async getSandboxInfo(sessionId) {
    if (sandboxes.has(sessionId)) {
      logger.debug('[E2BCode] Reusing existing sandbox', { sessionId });
      const sandboxInfo = sandboxes.get(sessionId);
      sandboxInfo.lastAccessed = Date.now();
      return sandboxInfo;
    }
    logger.error('[E2BCode] No sandbox found for session', { sessionId });
    throw new Error(
      `No sandbox found for sessionId ${sessionId}. Please create one using the 'create' action.`
    );
  }
}

async function cleanupInactiveSandboxes() {
  const now = Date.now();
  logger.debug('[E2BCode] Starting sandbox cleanup');
  for (const [sessionId, sandboxInfo] of sandboxes.entries()) {
    const { sandbox, lastAccessed } = sandboxInfo;
    if (now - lastAccessed > 10 * 60 * 1000) {
      logger.debug('[E2BCode] Cleaning up inactive sandbox', {
        sessionId,
        inactiveDuration: `${Math.floor((now - lastAccessed) / 1000)}s`,
      });
      try {
        await sandbox.kill();
      } catch (err) {
        logger.error('[E2BCode] Error killing sandbox', {
          sessionId,
          error: err.message,
        });
      }
      sandboxes.delete(sessionId);
    }
  }
  logger.debug('[E2BCode] Sandbox cleanup completed', {
    remainingSandboxes: sandboxes.size,
  });
}

// Run cleanup every 5 minutes
setInterval(cleanupInactiveSandboxes, 5 * 60 * 1000);

module.exports = E2BCode;