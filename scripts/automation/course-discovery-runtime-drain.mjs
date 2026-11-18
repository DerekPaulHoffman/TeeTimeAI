import { lstatSync, readFileSync } from 'node:fs';

/** Temporary local process coordination, never customer demand or job state.
 * An updater must see two fresh idle acknowledgements of this exact nonce
 * before it stops the managed process. Invalid requests receive no ack. */
export function createRuntimeDrainReader({ path, runtimeVersion, now = Date.now,
  stat = lstatSync, read = readFileSync } = {}) {
  return () => {
    if (!path || !/^[a-f0-9]{40}$/u.test(runtimeVersion ?? '')) return null;
    try {
      const info = stat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) return null;
      const raw = read(path, 'utf8');
      if (Buffer.byteLength(raw) > 4096) return null;
      const request = JSON.parse(raw);
      if (!request || Array.isArray(request) || Object.keys(request).sort().join(',') !==
          'expiresAt,fromRuntimeVersion,issuedAt,nonce,purpose,schemaVersion,targetRuntimeVersion' ||
          request.schemaVersion !== 1 || request.purpose !== 'UPGRADE_READER_RUNTIME' ||
          !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(request.nonce ?? '') ||
          !/^[a-f0-9]{40}$/u.test(request.fromRuntimeVersion ?? '') ||
          !/^[a-f0-9]{40}$/u.test(request.targetRuntimeVersion ?? '') ||
          ![request.fromRuntimeVersion, request.targetRuntimeVersion].includes(runtimeVersion)) return null;
      const issued = Date.parse(request.issuedAt), expires = Date.parse(request.expiresAt), clock = now();
      if (!Number.isFinite(issued) || !Number.isFinite(expires) || issued > clock + 5000 ||
          expires <= clock || expires <= issued || expires - issued > 180_000) return null;
      return { nonce: request.nonce };
    } catch { return null; }
  };
}
