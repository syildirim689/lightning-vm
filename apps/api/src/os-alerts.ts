// Tells the people who look after the panel's own server when security updates wait on it or it needs a restart.
// The state is what the host agent recorded (scripts/install.sh os); each finding is announced once a day at most.
import { redis } from './db';
import { logEvent } from './log';
import { bootId, osInfo } from './maintenance';
import { notify } from './notify';

export function startOsAlerts() {
  const run = async () => {
    if (!(await redis.set('lock:os-alerts', '1', 'EX', 1500, 'NX').catch(() => null))) return;
    try {
      const o = osInfo();
      // Older than two days: the agent is off or the timer does not run; nothing certain to say.
      if (!o || o.manager === 'none' || Date.now() - Date.parse(o.checkedAt) > 2 * 86_400_000) return;
      const boot = bootId();
      const restart = o.rebootRequired && (!boot || !o.bootId || o.bootId === boot);
      // Automatic security updates install them within a day: only say so when they stay.
      if (o.security > 0 && !(o.autoSecurity && Date.now() - Date.parse(o.listsAt || o.checkedAt) < 86_400_000) && (await redis.set('os-alert:security', '1', 'EX', 86_400, 'NX')))
        await notify('admin.os_updates', 'staff:system.view', { kind: 'security', count: String(o.security), total: String(o.total) });
      if (restart && (await redis.set(`os-alert:restart:${o.bootId || 'x'}`, '1', 'EX', 7 * 86_400, 'NX')))
        await notify('admin.os_updates', 'staff:system.view', { kind: 'restart', count: '0', total: String(o.total) });
    } catch { logEvent('error', 'os_alerts_failed'); }
  };
  setTimeout(run, 90_000).unref();
  return setInterval(run, 30 * 60_000).unref();
}
