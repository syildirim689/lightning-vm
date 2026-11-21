-- The block range index on the samples' time (088) is how the hourly roll-up finds "the samples since the newest
-- hour" without reading the table. A block range index only knows the ranges it has summarized, and by default new
-- ranges are summarized when the table is next vacuumed: on a table that mostly grows that is every few days, and
-- until then every new range (up to a fifth of the table) is read by each hourly run. With autosummarize a range is
-- summarized as soon as the next one begins, so the run reads the last range only.
-- A setting on the index: nothing is rewritten, no data is read, and it holds no lock longer than the statement.
ALTER INDEX server_cpu_samples_at SET (autosummarize = on);
