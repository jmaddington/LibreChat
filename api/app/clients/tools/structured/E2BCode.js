const { z } = require('zod');
const { Tool } = require('@langchain/core/tools');
const { getEnvironmentVariable } = require('@langchain/core/utils/env');
const { Sandbox } = require('@e2b/code-interpreter');
const { logger } = require('~/config');

const MAX_OUTPUT_LENGTH = 10000; // 10k characters
const MAX_TAIL_LINES = 20;
const MAX_TAIL_BYTES = 2000; // ~2KB

// Store active sandboxes with their session IDs
const sandboxes = (global.sandboxes = global.sandboxes || new Map());

class E2BCode extends Tool {
  constructor(fields = {}) {
    super();
    const envVar = 'E2B_API_KEY';
    const override = fields.override ?? false;
    this.apiKey = fields.apiKey ?? this.getApiKey(envVar, override);
    const keySuffix = this.apiKey ? this.apiKey.slice(-5) : 'none';
    logger.debug('[E2BCode] Initialized with API key ' + `*****${keySuffix}`);
    this.name = 'E2BCode';
    this.description = `
    Use E2B to execute code, run shell commands, manage files, install packages, and manage sandbox environments in an isolated sandbox environment.

    YOU CANNOT RUN MORE THAN 25 COMMANDS SEQUENTIALLY WITHOUT OUTPUT TO THE USER!

    Sessions: You must provide a unique \`sessionId\` string to maintain session state between calls. Use the same \`sessionId\` for related actions.

    Use the help action before executing anything else to understand the available actions and parameters. Before you run a command for the first
    time, use the help action for that command to understand the parameters required for that action.

    To copy files from one sandbox to another is to gzip them, then use the get_download_url action to get a link,
    and then use wget on the new sandbox to download.
    `;

    this.schema = z.object({
      sessionId: z
        .string()
        .optional()
        .describe(
          'A unique identifier for the session. Use the same `sessionId` to maintain state across multiple calls.'
        ),
      sandboxId: z
        .string()
        .optional()
        .describe(
          'The sandbox ID to use for the kill_sandbox action. If not provided, the sandbox associated with the `sessionId` will be used.'
        ),
      action: z
        .enum([
          'help',
          'create',
          'list_sandboxes',
          'kill',
          'set_timeout',
          'shell',
          'kill_command',
          'write_file',
          'read_file',
          'install',
          'get_file_downloadurl',
          'get_host',
          'command_run',
          'start_server',
          'command_list',
          'command_kill',
          'processinfo',
          'system_install',
        ])
        .describe('The action to perform.'),
      template: z
        .string()
        .optional()
        .describe(
          'Sandbox template name or ID to create the sandbox from (used with `create` action).'
        ),
      language: z
        .enum(['python', 'javascript', 'typescript', 'shell'])
        .optional()
        .describe('The programming language environment for installs. Defaults to `python`.'),
      cmd: z
        .string()
        .optional()
        .describe(
          'Command to execute (used with `shell`, `command_run` and `start_server` actions).'
        ),
      background: z
        .boolean()
        .optional()
        .describe(
          'Whether to run the command in the background (for `command_run`, `shell` actions). Defaults to `false`.'
        ),
      cwd: z
        .string()
        .optional()
        .describe(
          'Working directory for the command (used with `command_run` and `start_server` actions).'
        ),
      timeoutMs: z
        .number()
        .int()
        .min(1000)
        .default(60 * 1000)
        .optional()
        .describe(
          'Timeout in milliseconds for the command (used with `command_run` and `start_server` actions).'
        ),
      user: z
        .string()
        .optional()
        .describe(
          'User to run the command as (used with `command_run` and `start_server` actions).'
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
          'Path for read/write operations (used with `write_file`, `read_file`, and `get_file_downloadurl` actions).'
        ),
      fileContent: z
        .string()
        .optional()
        .describe('Content to write to file (required for `write_file` action).'),
      port: z
        .number()
        .int()
        .optional()
        .describe(
          'Port number to use for the host (used with `get_host` and `start_server` actions).'
        ),
      logFile: z
        .string()
        .optional()
        .describe(
          'Path to the log file where stdout and stderr will be redirected (required for `start_server` action).'
        ),
      timeout: z
        .number()
        .int()
        .optional()
        .default(60)
        .describe(
          'Timeout in minutes for the sandbox environment. Defaults to 60 minutes.'
        ),
      envs: z
        .record(z.string(), z.string())
        .optional()
        .describe(
          'Environment variables to set when creating the sandbox (used with `create` action) and for other actions that run commands.'
        ),
      command_name: z
        .string()
        .optional()
        .describe(
          'The name of the command to get detailed help about (used with the `help` action).'
        ),
      pid: z
        .number()
        .int()
        .optional()
        .describe(
          'Process ID of the command to kill (required for `command_kill` action) or get info (required for `processinfo` action).'
        ),
      packages: z
        .array(z.string())
        .optional()
        .describe('List of packages to install (used with `install` and `system_install` actions).')
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

  // Method to retrieve hidden environment variables starting with E2B_CODE_EV_
  getHiddenEnvVars() {
    const hiddenEnvVars = {};
    Object.keys(process.env).forEach((key) => {
      if (key.startsWith('E2B_CODE_EV_')) {
        hiddenEnvVars[key.substring('E2B_CODE_EV_'.length)] = process.env[key];
      }
    });
    return hiddenEnvVars;
  }

  // If the output is too large, return an error message and the last 20 lines (up to 2KB).
  safeReturn(obj) {
    let str = JSON.stringify(obj);
    if (str.length > MAX_OUTPUT_LENGTH) {
      // Extract last 20 lines of the JSON output (based on newline).
      const lines = str.split('\n');
      const tailLines = lines.slice(-MAX_TAIL_LINES).join('\n');

      // Truncate to 2KB if needed
      let truncated = tailLines;
      if (Buffer.byteLength(truncated, 'utf8') > MAX_TAIL_BYTES) {
        truncated = truncated.slice(0, 2000);
      }

      // Return error message with truncated output
      return JSON.stringify({
        error: 'Output too long. We are truncating the output. If you need more, please rerun the command and redirect the output to a log file that you can tail if needed.',
        truncated_tail: truncated
      });
    }
    return str;
  }

  getDetailedHelp(commandName) {
    const helpTexts = {
      'help': `
      Returns information about every possible action that can be performed using the E2BCode tool.
      `,
      'create': `
  **create**
  
  - **Description:** Create a new E2B sandbox environment from a template.
  
  - **Required Parameters:**
    - \`sessionId\`: A unique identifier for the session. Use the same \`sessionId\` to maintain state across multiple calls.
  
  - **Optional Parameters:**
    - \`template\`: The sandbox template name or ID to create the environment from.
    - \`timeout\`: Timeout in minutes for the sandbox environment. Defaults to 60 minutes.
    - \`envs\`: A key-value object of environment variables to set when creating the sandbox.
  `,
      'list_sandboxes': `
  **list_sandboxes**
  
  - **Description:** List all active E2B sandboxes for the current session.
  
  - **Parameters:** None (include \`sessionId\` for consistency).
  `,
      'kill': `
  **kill**
  
  - **Description:** Terminate the E2B sandbox environment associated with the provided \`sessionId\` or \`sandboxId\`.
  
  - **Required Parameters:**
    - Either \`sessionId\` or \`sandboxId\` must be provided. If both are provided \`sandboxId\` will take precedence.
  `,
      'set_timeout': `
  **set_timeout**
  
  - **Description:** Update the timeout for the sandbox environment to keep it alive for the specified duration.
  
  - **Required Parameters:**
    - \`sessionId\`
    - \`timeout\`: Timeout in minutes for the sandbox environment.
  `,
      'shell': `
  **shell**
  
  - **Description:** Run a shell command inside the sandbox environment.
  
  - **Required Parameters:**
    - \`sessionId\`
    - \`cmd\`: The shell command to execute.
  
  - **Optional Parameters:**
    - \`background\`: Whether to run the shell command in the background. Boolean value; defaults to \`false\`.
    - \`envs\`: Environment variables to set for this execution.
  `,
      'kill_command': `
  **kill_command**
  
  - **Description:** Terminate a background shell command that was previously started.
  
  - **Required Parameters:**
    - \`sessionId\`
    - \`commandId\`: The ID of the background command to kill.
  `,
      'write_file': `
  **write_file**
  
  - **Description:** Write content to a file in the sandbox environment.
  
  - **Required Parameters:**
    - \`sessionId\`
    - \`filePath\`: The path to the file where content will be written.
    - \`fileContent\`: The content to write to the file.
  `,
      'read_file': `
  **read_file**
  
  - **Description:** Read the content of a file from the sandbox environment.
  
  - **Required Parameters:**
    - \`sessionId\`
    - \`filePath\`: The path to the file to read.
  `,
      'install': `
  **install**
  
  - **Description:** Install python or node packages within the sandbox environment.
  Use \`system_install\` for system packages.
  
  - **Required Parameters:**
    - \`sessionId\`
    - \`packages\`: An array of package names to install.
  
  - **Optional Parameters:**
    - \`language\`: The environment to use (\`python\` uses pip, \`javascript\` or \`typescript\` use npm). Defaults to \`python\`.
    - \`envs\`: Environment variables to set for this installation.
  `,
      'get_file_downloadurl': `
  **get_file_downloadurl**
  
  - **Description:** Obtain a download URL for a file in the sandbox environment.
  
  - **Required Parameters:**
    - \`sessionId\`
    - \`filePath\`: The path to the file for which to generate a download URL.
  `,
      'get_host': `
  **get_host**
  
  - **Description:** Retrieve the host and port information for accessing services running inside the sandbox.
  
  - **Required Parameters:**
    - \`sessionId\`
    - \`port\`: The port number that the service is running on inside the sandbox.
  `,
      'command_run': `
  **command_run**
  
  - **Description:** Start a new command and wait until it finishes executing, or run it in the background.
  Use this for running most commands that do not require a PTY session.
  
  - **Required Parameters:**
    - \`sessionId\`
    - \`cmd\`: The command to execute.
  
  - **Optional Parameters:**
    - \`background\`: Whether to run the command in the background. Defaults to \`false\`.
    - \`cwd\`: Working directory for the command.
    - \`timeoutMs\`: Timeout in milliseconds for the command.
    - \`user\`: User to run the command as.
    - \`envs\`: Environment variables to set for this command.
  `,
      'start_server': `
  **start_server**
  
  - **Description:** Start a server process (e.g., nginx, flask) in the sandbox environment by executing a command in the background, 
  redirecting stdout and stderr to a specified log file, and returning the host and port information for accessing the server.
  
  - **Required Parameters:**
    - \`sessionId\`
    - \`cmd\`: The command to execute to start the server.
    - \`port\`: The port number on which the server is expected to listen inside the sandbox.
    - \`logFile\`: The path to the log file where stdout and stderr will be redirected.
  
  - **Optional Parameters:**
    - \`cwd\`: Working directory for the command.
    - \`timeoutMs\`: Timeout in milliseconds for the command.
    - \`user\`: User to run the command as.
    - \`envs\`: Environment variables to set for this execution.
  
  - **Returns:**
    - \`sessionId\`: The session ID.
    - \`commandId\`: The ID of the background command started.
    - \`host\`: The host address to access the server.
    - \`logFile\`: The location of the log file.
    - \`message\`: Confirmation message of server start and log file location.
  `,
      'command_list': `
  **command_list**
  
  - **Description:** List all running commands and PTY sessions within the sandbox environment.
  
  - **Required Parameters:**
    - \`sessionId\`
  `,
      'command_kill': `
  **command_kill**
  
  - **Description:** Kill a running command specified by its process ID.
  
  - **Required Parameters:**
    - \`sessionId\`
    - \`pid\`: Process ID of the command to kill.
  `,
      'processinfo': `
  **processinfo**
  
  - **Description:** Get detailed information about a running command specified by its process ID.
  
  - **Required Parameters:**
    - \`sessionId\`
    - \`pid\`: Process ID of the command to get information about.
  `,
      'system_install': `
  **system_install**
  
  - **Description:** Install system packages within the sandbox environment using \`sudo apt-get install\`.
  
  - **Required Parameters:**
    - \`sessionId\`
    - \`packages\`: An array of system package names to install.
  
  - **Optional Parameters:**
    - \`envs\`: Environment variables to set for this installation.
  `,
    };

    return helpTexts[commandName];
  }

  async _call(input) {
    const {
      sessionId,
      sandboxId,
      packages,
      language = 'python',
      action,
      cmd,
      background = false,
      cwd,
      timeoutMs = 30 * 1000,
      user,
      commandId,
      filePath,
      fileContent,
      port,
      timeout = 60 * 60,
      envs,
      command_name,
      logFile,
      pid,
      template,
    } = input;

    // Make sure we have sessionId or sandboxId for all actions except help and list_sandboxes, and create
    if (
      action !== 'help' &&
      action !== 'list_sandboxes' &&
      action !== 'create' &&
      (!sessionId || (!sandboxId && action !== 'create'))
    ) {
      logger.error('[E2BCode] `sessionId` is required for most actions', {
        action,
      });
    }

    let adjustedTimeoutMs = timeoutMs;
    if (adjustedTimeoutMs < 1000) {
      adjustedTimeoutMs = 1000;
    }

    let adjustedTimeout = timeout;
    if (adjustedTimeout < 1) {
      adjustedTimeout = 1;
    }

    logger.debug('[E2BCode] Processing request', {
      action,
      language,
      sessionId,
    });

    try {
      switch (action) {
        case 'help':
          if (command_name) {
            // Return detailed help about the specified command
            const detailedHelp = this.getDetailedHelp(command_name.trim());
            if (detailedHelp) {
              return JSON.stringify({ message: detailedHelp });
            } else {
              return JSON.stringify({
                message: `No detailed help available for command '${command_name}'.`,
              });
            }
          } else {
            // Return overview of available commands
            const commandList = [
              'help',
              'create',
              'list_sandboxes',
              'kill',
              'set_timeout',
              'shell',
              'kill_command',
              'write_file',
              'read_file',
              'install',
              'system_install',
              'get_file_downloadurl',
              'get_host',
              'command_run',
              'start_server',
              'command_list',
              'command_kill',
              'processinfo',
            ];
            const overview = `Available actions: ${commandList.join(', ')}. Use 'help' with a command name to get detailed help about a specific command. You are HIGHLY encouraged to run help for system_install, command_run, shell and start_server to understand the differences between them and how to use them.`;
            return JSON.stringify({ message: overview });
          }

        case 'create': {
          if (sandboxes.has(sessionId)) {
            logger.error('[E2BCode] Sandbox already exists', { sessionId });
            throw new Error(`Sandbox with sessionId ${sessionId} already exists.`);
          }
          logger.debug('[E2BCode] Creating new sandbox', {
            sessionId,
            timeout: adjustedTimeout,
          });
          const sandboxCreateOptions = {
            apiKey: this.apiKey,
            timeoutMs: adjustedTimeout * 60 * 1000,
          };

          // Get hidden environment variables
          const hiddenEnvVarsCreate = this.getHiddenEnvVars();
          // Merge hidden env vars with any provided envs, without exposing hidden vars to the LLM
          if (Object.keys(hiddenEnvVarsCreate).length > 0 || envs) {
            sandboxCreateOptions.env = {
              ...hiddenEnvVarsCreate,
              ...envs,
            };
          }

          // If template is not provided, use a default template, e.g. 'ubuntu-latest'
          const sandboxTemplate = template || 'ubuntu-latest';

          const sandboxCreate = await Sandbox.create(sandboxTemplate, sandboxCreateOptions);
          sandboxes.set(sessionId, {
            sandbox: sandboxCreate,
            lastAccessed: Date.now(),
            commands: new Map(),
          });

          // Get current user and current directory inside the sandbox
          const whoamiResult = await sandboxCreate.commands.run('whoami');
          const currentUser = whoamiResult.stdout.trim();

          const pwdResult = await sandboxCreate.commands.run('pwd');
          const currentDirectory = pwdResult.stdout.trim();

          // Get sandbox ID
          const createdSandboxId = sandboxCreate.sandboxId;

          return JSON.stringify({
            sessionId,
            sandboxId: createdSandboxId,
            currentUser,
            currentDirectory,
            success: true,
            message: `Sandbox created from template '${sandboxTemplate}' with timeout ${adjustedTimeout} minutes.`,
          });
        }

        case 'list_sandboxes':
          logger.debug('[E2BCode] Listing all active sandboxes');
          try {
            const sandboxesList = await Sandbox.list({ apiKey: this.apiKey });
            if (sandboxesList.length === 0) {
              logger.debug('[E2BCode] No active sandboxes found');
              return JSON.stringify({
                message: 'No active sandboxes found',
              });
            }
            // Map sandbox info to include sandboxId and any other relevant details
            const sandboxDetails = sandboxesList.map((sandbox) => {
              const [id] = sandbox.sandboxId.split('-');
              return {
                sandboxId: id,
                createdAt: sandbox.createdAt,
                status: sandbox.status,
              };
            });
            return JSON.stringify({
              message: 'Active sandboxes found',
              sandboxes: sandboxDetails,
            });
          } catch (error) {
            logger.error('[E2BCode] Error listing sandboxes', { error: error.message });
            return JSON.stringify({
              error: 'Error listing sandboxes: ' + error.message,
            });
          }

        case 'kill':
          let killSandboxId = sandboxId;
          if (!killSandboxId) {
            // Try to get it from sessionId mapping
            if (sandboxes.has(sessionId)) {
              const sandboxInfo = sandboxes.get(sessionId);
              killSandboxId = sandboxInfo.sandbox.sandboxId;
            }
          }
          if (!killSandboxId) {
            logger.error('[E2BCode] No sandboxId or sessionId provided to kill', { sessionId });
            throw new Error(`No sandboxId or sessionId provided. Cannot kill sandbox.`);
          }
          const [validSandboxId] = killSandboxId.split('-');
          logger.debug('[E2BCode] Killing sandbox', { sessionId, validSandboxId });
          let sandboxToKill;
          try {
            sandboxToKill = await Sandbox.connect(validSandboxId, { apiKey: this.apiKey });
          } catch (error) {
            logger.error('[E2BCode] Error connecting to sandbox to kill', { sessionId, validSandboxId, error: error.message });
            if (sandboxes.has(sessionId)) {
              sandboxes.delete(sessionId);
            }
            return JSON.stringify({
              sessionId,
              success: false,
              message: `No sandbox found with sandboxId ${validSandboxId} and sessionId ${sessionId}.`,
            });
          }

          try {
            await sandboxToKill.kill();
          } catch (error) {
            logger.error('[E2BCode] Error killing sandbox', { sessionId, validSandboxId, error: error.message });
            if (sandboxes.has(sessionId)) {
              sandboxes.delete(sessionId);
            }
            return JSON.stringify({
              sessionId,
              success: false,
              message: `Failed to kill sandbox with sandboxId ${validSandboxId} and sessionId ${sessionId}.`,
            });
          }

          if (sandboxes.has(sessionId)) {
            sandboxes.delete(sessionId);
          }

          return JSON.stringify({
            sessionId,
            success: true,
            message: `Sandbox with sessionId ${sessionId} and sandboxId ${validSandboxId} has been killed.`,
          });

        case 'set_timeout':
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
            timeout: adjustedTimeout,
          });
          const { sandbox: sandboxSetTimeout } = sandboxes.get(sessionId);
          await sandboxSetTimeout.setTimeout(adjustedTimeout * 60 * 1000);
          return JSON.stringify({
            sessionId,
            success: true,
            message: `Sandbox timeout updated to ${adjustedTimeout} minutes.`,
          });

        default:
          // For other actions, proceed to get the sandbox
          const sandboxInfo = await this.getSandboxInfo(sessionId);
          const sandbox = sandboxInfo.sandbox;
          // Get hidden environment variables
          const hiddenEnvVars = this.getHiddenEnvVars();

          switch (action) {
            case 'shell':
              if (!cmd) {
                logger.error('[E2BCode] Command (cmd) missing for shell action', {
                  sessionId,
                });
                throw new Error('Command (cmd) is required for `shell` action.');
              }
              logger.debug('[E2BCode] Executing shell command', {
                sessionId,
                cmd,
                background,
              });
              const shellOptions = {};
              if (Object.keys(hiddenEnvVars).length > 0 || envs) {
                shellOptions.envs = {
                  ...hiddenEnvVars,
                  ...envs,
                };
              }
              if (background) {
                shellOptions.background = true;
                const backgroundCommand = await sandbox.commands.run(
                  cmd,
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
                  cmd,
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
              const commandToKill = sandboxInfo.commands.get(commandId);
              if (!commandToKill) {
                logger.error('[E2BCode] No command found to kill', {
                  sessionId,
                  commandId,
                });
                throw new Error(
                  `No background command found with ID ${commandId}.`
                );
              }
              await commandToKill.kill();
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
              if (!packages || packages.length === 0) {
                logger.error(
                  '[E2BCode] Packages missing for install action',
                  {
                    sessionId,
                    language,
                  }
                );
                throw new Error('`packages` array is required for `install` action.');
              }
              logger.debug('[E2BCode] Installing packages', {
                sessionId,
                language,
                packages,
              });
              const installOptions = {};
              if (Object.keys(hiddenEnvVars).length > 0 || envs) {
                installOptions.envs = {
                  ...hiddenEnvVars,
                  ...envs,
                };
              }
              if (language === 'python') {
                const pipResult = await sandbox.commands.run(
                  `pip install ${packages.join(' ')}`,
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
                  `npm install ${packages.join(' ')}`,
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
              } else {
                logger.error(
                  '[E2BCode] Unsupported language for package installation',
                  { sessionId, language }
                );
                throw new Error(
                  `Unsupported language for package installation: ${language}`
                );
              }

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

            case 'system_install':
              if (!packages || packages.length === 0) {
                logger.error('[E2BCode] Packages missing for system_install action', { sessionId });
                throw new Error('`packages` array is required for `system_install` action.');
              }
              logger.debug('[E2BCode] Installing system packages', {
                sessionId,
                packages,
              });
              const aptGetInstallCommand = `sudo apt-get update && sudo apt-get install -y ${packages.join(' ')}`;
              const systemInstallOptions = {};
              if (Object.keys(hiddenEnvVars).length > 0 || envs) {
                systemInstallOptions.envs = {
                  ...hiddenEnvVars,
                  ...envs,
                };
              }
              const aptGetResult = await sandbox.commands.run(aptGetInstallCommand, systemInstallOptions);
              logger.debug('[E2BCode] System package installation completed', {
                sessionId,
                success: aptGetResult.exitCode === 0,
              });
              return JSON.stringify({
                sessionId,
                success: aptGetResult.exitCode === 0,
                output: aptGetResult.stdout,
                error: aptGetResult.stderr,
              });

            case 'command_run':
              if (!cmd) {
                logger.error('[E2BCode] `cmd` is missing for command_run action', {
                  sessionId,
                });
                throw new Error('`cmd` is required for `command_run` action.');
              }
              logger.debug('[E2BCode] Running command', {
                sessionId,
                cmd,
                background,
              });
              const commandOptions = {};
              if (background !== undefined) {
                commandOptions.background = background;
              }
              if (cwd) {
                commandOptions.cwd = cwd;
              }
              if (adjustedTimeoutMs) {
                commandOptions.timeoutMs = adjustedTimeoutMs;
              }
              if (user) {
                commandOptions.user = user;
              }
              if (Object.keys(hiddenEnvVars).length > 0 || envs) {
                commandOptions.envs = {
                  ...hiddenEnvVars,
                  ...envs,
                };
              }
              if (background) {
                const commandHandle = await sandbox.commands.run(cmd, commandOptions);
                const cmdId = commandHandle.id;
                sandboxInfo.commands.set(cmdId, commandHandle);
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
                const commandResult = await sandbox.commands.run(cmd, commandOptions);
                logger.debug('[E2BCode] Command execution completed', {
                  sessionId,
                  exitCode: commandResult.exitCode,
                });
                return JSON.stringify({
                  sessionId,
                  stdout: commandResult.stdout,
                  stderr: commandResult.stderr,
                  exitCode: commandResult.exitCode,
                  success: commandResult.exitCode === 0,
                });
              }

            case 'start_server':
              if (!cmd) {
                logger.error('[E2BCode] `cmd` is missing for start_server action', {
                  sessionId,
                });
                throw new Error('`cmd` is required for `start_server` action.');
              }
              if (!port) {
                logger.error('[E2BCode] `port` is missing for start_server action', {
                  sessionId,
                });
                throw new Error('`port` is required for `start_server` action.');
              }
              if (!logFile) {
                logger.error('[E2BCode] `logFile` is missing for start_server action', {
                  sessionId,
                });
                throw new Error('`logFile` is required for `start_server` action.');
              }
              logger.debug('[E2BCode] Starting server', {
                sessionId,
                cmd,
                port,
                logFile,
              });
              const serverCommand = `${cmd} > ${logFile} 2>&1`;
              const serverOptions = {};
              serverOptions.background = true;
              if (cwd) {
                serverOptions.cwd = cwd;
              }
              if (adjustedTimeoutMs) {
                serverOptions.timeoutMs = adjustedTimeoutMs;
              }
              if (user) {
                serverOptions.user = user;
              }
              if (Object.keys(hiddenEnvVars).length > 0 || envs) {
                serverOptions.envs = {
                  ...hiddenEnvVars,
                  ...envs,
                };
              }
              const serverHandle = await sandbox.commands.run(
                serverCommand,
                serverOptions
              );
              const serverCommandId = serverHandle.id;
              sandboxInfo.commands.set(serverCommandId, serverHandle);
              logger.debug('[E2BCode] Server started', {
                sessionId,
                commandId: serverCommandId,
              });
              const serverHost = await sandbox.getHost(port);
              logger.debug('[E2BCode] Host+port retrieved', { sessionId, serverHost });
              return JSON.stringify({
                sessionId,
                commandId: serverCommandId,
                success: true,
                serverHost,
                logFile,
                message: `Server started with ID ${serverCommandId}, accessible at ${serverHost}:${port}. Logs are redirected to ${logFile}`,
              });

            case 'command_list':
              // Retrieve the list of running commands and PTY sessions
              const processList = await sandbox.commands.list();
              logger.debug('[E2BCode] Retrieved list of commands', {
                sessionId,
                processCount: processList.length,
              });
              return JSON.stringify({
                sessionId,
                success: true,
                processes: processList,
              });

            case 'command_kill':
              if (pid === undefined) {
                logger.error(
                  '[E2BCode] `pid` is missing for `command_kill` action',
                  { sessionId }
                );
                throw new Error('`pid` is required for `command_kill` action.');
              }
              logger.debug('[E2BCode] Killing process', {
                sessionId,
                pid,
              });
              const killResult = await sandbox.commands.kill(pid);
              if (killResult) {
                logger.debug('[E2BCode] Process killed successfully', {
                  sessionId,
                  pid,
                });
                return JSON.stringify({
                  sessionId,
                  success: true,
                  message: `Process with PID ${pid} has been killed.`,
                });
              } else {
                logger.error('[E2BCode] Failed to kill process', {
                  sessionId,
                  pid,
                });
                return JSON.stringify({
                  sessionId,
                  success: false,
                  message: `Failed to kill process with PID ${pid}.`,
                });
              }

            case 'processinfo':
              if (pid === undefined) {
                logger.error(
                  '[E2BCode] `pid` is missing for `processinfo` action',
                  { sessionId }
                );
                throw new Error('`pid` is required for `processinfo` action.');
              }
              logger.debug('[E2BCode] Getting process info', {
                sessionId,
                pid,
              });
              const processinfo_processList = await sandbox.commands.list();
              const processInfo = processinfo_processList.find((p) => p.pid === pid);
              if (processInfo) {
                logger.debug('[E2BCode] Process info retrieved', {
                  sessionId,
                  pid,
                });
                return JSON.stringify({
                  sessionId,
                  success: true,
                  process: processInfo,
                });
              } else {
                logger.error('[E2BCode] Process not found', {
                  sessionId,
                  pid,
                });
                return JSON.stringify({
                  sessionId,
                  success: false,
                  message: `No process found with PID ${pid}.`,
                });
              }

            default:
              logger.error('[E2BCode] Unknown action requested', {
                sessionId,
                action,
              });
              throw new Error(`Unknown action: ${action}`);
          }
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

module.exports = E2BCode;