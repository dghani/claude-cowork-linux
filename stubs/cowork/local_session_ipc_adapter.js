function isLocalSessionIpcResultChannel(channel) {
  return typeof channel === 'string' && (
    channel.includes('LocalAgentModeSessions_$_getTranscript') ||
    channel.includes('LocalSessions_$_getTranscript') ||
    channel.includes('LocalAgentModeSessions_$_getSession') ||
    channel.includes('LocalSessions_$_getSession') ||
    channel.includes('LocalAgentModeSessions_$_getAll') ||
    channel.includes('LocalSessions_$_getAll')
  );
}

// @session-refactor:NORM-048 DEFINITION — wrap IPC handler to normalize result on return
function wrapLocalSessionIpcHandler(channel, handler, localSessionBridge) {
  if (!isLocalSessionIpcResultChannel(channel) || typeof handler !== 'function') {
    return handler;
  }
  if (!localSessionBridge || typeof localSessionBridge.normalizeLocalSessionIpcResult !== 'function') {
    return handler;
  }
  if (handler.__coworkLocalSessionIpcWrapped) {
    return handler;
  }

  const wrappedHandler = async (...args) => {
    const result = await handler(...args);
    // @session-refactor:NORM-047 CALLER — normalize IPC result before returning to caller
    return localSessionBridge.normalizeLocalSessionIpcResult(channel, result);
  };

  wrappedHandler.__coworkLocalSessionIpcWrapped = true;
  wrappedHandler.__coworkLocalSessionIpcOriginal = handler;
  return wrappedHandler;
}

// @session-refactor:NORM-048 DEFINITION — export surface for wrapLocalSessionIpcHandler
module.exports = {
  isLocalSessionIpcResultChannel,
  wrapLocalSessionIpcHandler,
};
