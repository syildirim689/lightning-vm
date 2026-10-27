-- The person's own time zone for the panel's dates and times (NULL: their browser's).
ALTER TABLE users ADD COLUMN time_zone text CHECK (time_zone IS NULL OR length(time_zone) <= 64);
