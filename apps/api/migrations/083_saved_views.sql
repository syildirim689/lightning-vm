-- Saved views of the panel's lists (saved-views.ts): a name for a list's filters and order, kept with the account
-- instead of the browser. Per person and list; name_key is the name with case and Turkish letters folded (unique per
-- person and list); at most one default per person and list. The rows go with the account.
CREATE TABLE saved_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  list text NOT NULL,
  name text NOT NULL,
  name_key text NOT NULL,
  params jsonb NOT NULL DEFAULT '{}',
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX saved_views_name ON saved_views (user_id, list, name_key);
CREATE UNIQUE INDEX saved_views_default ON saved_views (user_id, list) WHERE is_default;
