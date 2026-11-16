// The host agent's last task, as the admin pages read it. A task still marked "running" three hours after it
// started is one the agent never finished reporting (it was restarted, the host went down): the API treats it as
// dead, and so do the pages, or their buttons would stay busy for ever.
const STALE_MS = 3 * 3_600_000;

export const agentRunning = (status?: { state: string; startedAt?: string } | null) =>
  status?.state === 'running' && !(status.startedAt && Date.now() - Date.parse(status.startedAt) > STALE_MS);
