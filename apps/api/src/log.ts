// Technical log line: stable English event code, never secrets or request bodies.
export function logEvent(level: 'info' | 'warn' | 'error' | 'fatal', event: string, fields: Record<string, unknown> = {}) {
  console.error(JSON.stringify({ level, service: 'api', event, time: new Date().toISOString(), ...fields }));
}
