-- The month in which "this month is heading over your budget" went out (cost-forecast.ts), as budget_alerted keeps it
-- for "your budget is exceeded": once per calendar month, and again after the budget is changed.
ALTER TABLE users ADD COLUMN budget_forecast_alerted text;
