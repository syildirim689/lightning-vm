-- A session staff opened as someone else (impersonated_by) ends when it was first set to end, an hour after it
-- started. The sign-in library moves a session's end to the normal session length whenever it is used unless the
-- browser sends a cookie asking it not to: for these sessions the end never moves later, whatever the client sends.
UPDATE auth_sessions SET expires_at = created_at + interval '1 hour' WHERE impersonated_by IS NOT NULL AND expires_at > created_at + interval '1 hour';
CREATE FUNCTION auth_sessions_keep_impersonation_end() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.impersonated_by IS NOT NULL AND NEW.expires_at > OLD.expires_at THEN NEW.expires_at := OLD.expires_at; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER auth_sessions_impersonation_end BEFORE UPDATE ON auth_sessions FOR EACH ROW EXECUTE FUNCTION auth_sessions_keep_impersonation_end();
-- Ending the sessions a staff member started as others (when their access shrinks or ends) looks them up by this.
CREATE INDEX auth_sessions_impersonated_by_idx ON auth_sessions (impersonated_by) WHERE impersonated_by IS NOT NULL;
