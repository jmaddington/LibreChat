const E2BCode = require('../E2BCode');
const { Sandbox } = require('@e2b/code-interpreter');
const { getEnvironmentVariable } = require('@langchain/core/utils/env');
const { createSandbox, findSandboxById, deleteSandboxBySessionId, getActiveSandboxes, setTimeoutForSandbox } = require('../../../../../models/Sandbox');
const { logger } = require('~/config');
const mockApiKey = 'mock_api_key';
jest.mock('@e2b/code-interpreter');
jest.mock('@langchain/core/utils/env');
jest.mock('../../../../../models/Sandbox');
getEnvironmentVariable.mockImplementationOnce(() => undefined).mockImplementation(() => mockApiKey);

createSandbox.mockImplementation(()=> jest.fn());
findSandboxById.mockImplementation(()=> jest.fn());
deleteSandboxBySessionId.mockImplementation(()=> jest.fn());
getActiveSandboxes.mockImplementation(()=> jest.fn());
setTimeoutForSandbox.mockImplementation(()=> jest.fn());


const mockRun = jest.fn().mockImplementation((command) => {
  if (command === 'whoami') {
    return Promise.resolve({
      stdout: 'sandbox-user\n',
      stderr: '',
      exitCode: 0
    });
  } else if (command === 'pwd') {
    return Promise.resolve({
      stdout: '/home/sandbox\n',
      stderr: '',
      exitCode: 0
    });
  }

  return Promise.resolve({
    stdout: '',
    stderr: '',
    exitCode: 0
  });
});

const mockSandbox = {
  envdPort: 49983,
  sandboxId: "ib1v2xb0f36jzttf1zyif-4b1cc5d5",
  connectionConfig: {
    apiKey: mockApiKey,
    debug: false,
    domain: "e2b.dev",
    requestTimeoutMs: 30000,
    apiUrl: "https://api.e2b.dev"
  },
  downloadUrl: jest.fn(),
  getHost: jest.fn(),
  kill: jest.fn(),
  setTimeout: jest.fn(),
  commands: {
    run: mockRun,
    list: jest.fn(),
    kill: jest.fn(),
  },
  files: {
    write: jest.fn(),
    read: jest.fn(),
  }
}

Sandbox.create = jest.fn().mockResolvedValue(mockSandbox);
Sandbox.connect = jest.fn().mockResolvedValue(mockSandbox);
Sandbox.setTimeout = jest.fn().mockResolvedValue(mockSandbox);
Sandbox.list = jest.fn().mockResolvedValue([{
  sandboxId: 'ib1v2xb0f36jzttf1zyif-4b1cc5d5',
  createdAt: new Date(),
  status: 'active',
}]);

const inputForCreate = {
  sessionId: "test-sandbox-2",
  action: "create",
  timeout: 1
}

describe('E2BCode', () => {
  let originalEnv;
  let e2bcode;

  beforeAll(() => {
    // Save the original process.env
    originalEnv = { ...process.env };
  });

  beforeEach(() => {
    // Reset the process.env before each test
    jest.resetModules();
    process.env = { ...originalEnv, E2B_API_KEY: mockApiKey };
    // Instantiate E2BCode for tests
    e2bcode = new E2BCode({ override: false, userId: 'mock_user_id' });
  });

  afterEach(() => {
    jest.clearAllMocks();
    // Restore the original process.env after each test
    process.env = originalEnv;
  });

  it('should return an error if API key is missing', async () => {
    delete process.env.E2B_API_KEY;
    const result = await e2bcode.call({ action: 'list_sandboxes' });
    const data = JSON.parse(result);
    expect(data.error).toBe('Missing E2B_API_KEY environment variable');
  });

  it('A create action should call createSandbox() to create new record in db', async () => {
    const result = await e2bcode.call(inputForCreate);
    const data = JSON.parse(result)
    expect(createSandbox).toHaveBeenCalledWith(
      "ib1v2xb0f36jzttf1zyif-4b1cc5d5",
      "test-sandbox-2",
      'mock_user_id',
      60000
    );
  });

  it('A kill action should call deleteSandboxBySessionId() to delete record in db', async () => {
    await e2bcode.call(inputForCreate);
    const input = {
      sessionId: "test-sandbox-2",
      sandboxId: "ib1v2xb0f36jzttf1zyif-4b1cc5d5",
      action: "kill",
    }
    await e2bcode.call(input);
    expect(deleteSandboxBySessionId).toBeCalled();
  });

  it('A set timeout action should call setTimeoutForSandbox() to update record in db', async () => {
    await e2bcode.call(inputForCreate);
    const input = {
      sessionId: "test-sandbox-2",
      sandboxId: "ib1v2xb0f36jzttf1zyif-4b1cc5d5",
      action: "set_timeout",
      timeout: 1
    }
    await e2bcode.call(input);
    expect(setTimeoutForSandbox).toBeCalled();
  });

  it('A list sandboxes action should call findSandboxById() to get db records', async () => {
    await e2bcode.call(inputForCreate);
    const input = {
      sessionId: "test-sandbox-2",
      action: "list_sandboxes",
    }
    await e2bcode.call(input);
    expect(findSandboxById).toBeCalled();
  });

  it('A shell action should call getActiveSandboxes() to get db records', async () => {
    await e2bcode.call(inputForCreate);
    const input = {
      sessionId: "test-sandbox-2",
      sandboxId: "ib1v2xb0f36jzttf1zyif-4b1cc5d5",
      action: "shell",
      cmd: "ls"
    }
    await e2bcode.call(input);
    expect(getActiveSandboxes).toBeCalled();
  });
})
