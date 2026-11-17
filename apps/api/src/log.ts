// Technical log line: stable English event code, never secrets or request bodies.
export function logEvent(level: 'info' | 'warn' | 'error' | 'fatal', event: string, fields: Record<string, unknown> = {}) {
  console.error(JSON.stringify({ level, service: 'api', env: process.env.APP_ENV || 'production', event, time: new Date().toISOString(), ...fields }));
}

// Secrets that travel in URLs (a reset token in the path of the mailed link; sign-in link, verification, payment and
// provider-callback values in the query) never reach a log: the API's request line, and the copies of service logs
// staff can read (the proxy's access log holds the same URLs). Also where a JSON line wrote "&" as its escape, or
// the URL sits percent-encoded inside another one.
export const maskSecrets = (text: string) => text
  .replace(/(\/reset-password\/)[^/?#\s"'\\]+/gi, '$1[masked]')
  .replace(/((?:[?&]|\\[u]0026|%3f|%26)(?:token|code|state|session_id)(?:=|%3d))[^&#\s"'\\]*/gi, '$1[masked]');
