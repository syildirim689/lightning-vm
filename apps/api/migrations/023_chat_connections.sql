-- Messaging apps a user routes notifications to (chat.ts): a Telegram chat, a WhatsApp number, a Slack or Discord
-- webhook... target_enc holds the app's fields (webhook URLs are secrets), hint what the list may show.
CREATE TABLE chat_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app text NOT NULL,
  label text NOT NULL DEFAULT '',
  hint text NOT NULL DEFAULT '',
  target_enc text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  last_sent_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chat_connections_user ON chat_connections (user_id);
