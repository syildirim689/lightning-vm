// The month-end cost forecast: monthly prices by the days they exist, hourly usage as billing recorded it plus the
// current rate for the hours left; and where a figure stands against a budget.
import test from 'node:test';
import assert from 'node:assert/strict';

const { monthForecast, budgetLevel } = await import('../dist/forecast-rules.js');

const mid = new Date(Date.UTC(2026, 3, 16)); // 16 April 2026 00:00 UTC: half of a 30-day month, 15 days = 360 hours left
const old = new Date(Date.UTC(2026, 0, 1));

test('without hourly servers the forecast is the prorated monthly prices, as before', () => {
  assert.deepEqual(monthForecast([{ price: 30, createdAt: old }], null, mid), { monthly: 30, accrued: 15, forecast: 30, daysLeft: 15, hourly: null });
  assert.deepEqual(monthForecast([], null, mid), { monthly: 0, accrued: 0, forecast: 0, daysLeft: 15, hourly: null });
});

test('hourly usage counts as recorded, and the rate only for the hours the month still has', () => {
  // 100 hours at 0.05 recorded; the server still runs: 360 more hours.
  const f = monthForecast([], { accrued: 5, hours: 100, perHour: 0.05, monthly: 36.5 }, mid);
  assert.deepEqual(f, { monthly: 36.5, accrued: 5, forecast: 23, daysLeft: 15, hourly: { accrued: 5, hours: 100, perHour: 0.05, forecast: 23 } });
  // Deleted since (or held and switched off): what was spent stays, nothing is added.
  assert.equal(monthForecast([], { accrued: 5, hours: 100, perHour: 0, monthly: 0 }, mid).forecast, 5);
  // Together with a monthly server.
  const both = monthForecast([{ price: 30, createdAt: old }], { accrued: 5, hours: 100, perHour: 0.05, monthly: 36.5 }, mid);
  assert.deepEqual([both.monthly, both.accrued, both.forecast], [66.5, 20, 53]);
});

test('the last hour of the month adds nothing, the first adds the whole month; odd input is not negative', () => {
  const last = new Date(Date.UTC(2026, 3, 30, 23, 30));
  assert.equal(monthForecast([], { accrued: 36, hours: 720, perHour: 0.05, monthly: 36.5 }, last).forecast, 36);
  const first = new Date(Date.UTC(2026, 3, 1));
  assert.equal(monthForecast([], { accrued: 0, hours: 0, perHour: 0.05, monthly: 36.5 }, first).forecast, 36);
  // February of a leap year has 696 hours, not 720.
  assert.equal(monthForecast([], { accrued: 0, hours: 0, perHour: 1, monthly: 730 }, new Date(Date.UTC(2028, 1, 1))).forecast, 696);
  assert.equal(monthForecast([], { accrued: -3, hours: 0, perHour: -1, monthly: 0 }, mid).forecast, 0);
});

test('a figure against a budget: fine, close from 80%, over only above it', () => {
  assert.equal(budgetLevel(79.99, 100, 0.8), 'ok');
  assert.equal(budgetLevel(80, 100, 0.8), 'near');
  assert.equal(budgetLevel(100, 100, 0.8), 'near');
  assert.equal(budgetLevel(100.01, 100, 0.8), 'over');
  assert.equal(budgetLevel(50, 0, 0.8), 'ok', 'no budget');
});
