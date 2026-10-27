-- A server that used up its monthly traffic may be slowed down (Settings → Servers): its distributed ports get a speed
-- limit until the allowance covers its use again (a new month, or a bigger package).
ALTER TABLE servers ADD COLUMN traffic_throttled boolean NOT NULL DEFAULT false;
