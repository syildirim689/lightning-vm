// Pure rules of the month-end cost forecast (no database; unit-tested in test/forecast-rules.test.mjs).
import { monthCost } from './smart-rules';

// Hourly billing of one currency: what billing has recorded for this month so far (amount and hours, including
// servers deleted since), the hourly prices of the servers that are still building usage, and the monthly list prices
// of the hourly servers that exist (for the "monthly total" line).
export type HourlyUse = { accrued: number; hours: number; perHour: number; monthly: number };
export type MonthForecast = { monthly: number; accrued: number; forecast: number; daysLeft: number; hourly: { accrued: number; hours: number; perHour: number; forecast: number } | null };

const r2 = (x: number) => Math.round(x * 100) / 100;

// Monthly prices by the part of this (UTC) month each item exists, as before; hourly use as recorded, plus the current
// hourly rate for the hours the month still has. An hour that has started is already in the recorded usage (billing
// books an hour when it begins), so only whole hours still to begin are added.
export function monthForecast(monthly: { price: number; createdAt: Date }[], hourly: HourlyUse | null, now: Date): MonthForecast {
  const base = monthCost(monthly, now);
  if (!hourly) return { ...base, hourly: null };
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  const hoursLeft = Math.max(0, Math.floor((end - now.getTime()) / 3_600_000));
  const accrued = Math.max(0, hourly.accrued), perHour = Math.max(0, hourly.perHour);
  const ahead = accrued + perHour * hoursLeft;
  return { monthly: r2(base.monthly + hourly.monthly), accrued: r2(base.accrued + accrued), forecast: r2(base.forecast + ahead), daysLeft: base.daysLeft,
    hourly: { accrued: r2(accrued), hours: hourly.hours, perHour: Math.round(perHour * 10_000) / 10_000, forecast: r2(ahead) } };
}

// Where a figure stands against a budget: over it, within `near` of it (a share, 0.8 = 80%), or fine.
export function budgetLevel(value: number, amount: number, near: number): 'ok' | 'near' | 'over' {
  if (!(amount > 0)) return 'ok';
  const ratio = value / amount;
  return ratio > 1 ? 'over' : ratio >= near ? 'near' : 'ok';
}
