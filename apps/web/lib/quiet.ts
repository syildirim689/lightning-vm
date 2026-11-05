// Whether a wall-clock time ("HH:MM") falls in a daily quiet window; a window may run past midnight (23:00–08:00).
export const inQuietHours = (now: string, start: string, end: string) => start <= end ? now >= start && now < end : now >= start || now < end;

// The current "HH:MM" in a time zone.
export const clockIn = (tz: string, at = new Date()) => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz }).format(at);
