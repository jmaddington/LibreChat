const Sandbox = require('./schema/sandboxSchema');

async function createSandbox(sandboxId, sessionId, timeoutInMilliSeconds) {
  const expiredAt = new Date(Date.now() + timeoutInMilliSeconds);
  return await Sandbox.create({ sandboxId, sessionId, expiredAt });
}

async function setTimeoutForSandbox(sessionId, timeoutInMilliSeconds) {
  const newExpiredAt = new Date(Date.now() + timeoutInMilliSeconds);
  return await Sandbox.updateOne({ sessionId }, { expiredAt: newExpiredAt });
}

async function findSandboxById(sandboxId) {
  return await Sandbox.findOne({ sandboxId });
}

async function deleteSandboxById(sandboxId) {
  return await Sandbox.deleteOne({ sandboxId });
}

async function getActiveSandboxes() {
  return await Sandbox.find({});
}

module.exports = {
  createSandbox,
  findSandboxById,
  deleteSandboxById,
  getActiveSandboxes,
  setTimeoutForSandbox,
};
