/** Closed observations only. These labels confer no browser or source authority. */
export const guardedHostStartupStages = Object.freeze(['SPAWN', 'PROXY', 'EXTENSION', 'BROWSER_LAUNCH', 'CDP_CONNECT',
  'EXTENSION_INSTALL', 'CONTEXT_CREATE', 'TARGET_GUARDS', 'TARGET_CREATE', 'TARGET_READY', 'DEFAULT_CLEANUP', 'READY']);
export const guardedHostStartupFailures = Object.freeze(['TIMEOUT', 'CLOSED', 'OTHER']);
