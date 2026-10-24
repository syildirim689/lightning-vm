-- The owner's own labels for a server: tags to group and filter the list, and free-form notes.
ALTER TABLE servers
  ADD COLUMN tags text[] NOT NULL DEFAULT '{}' CHECK (cardinality(tags) <= 10),
  ADD COLUMN notes text NOT NULL DEFAULT '' CHECK (length(notes) <= 2000);
CREATE INDEX servers_tags_idx ON servers USING gin (tags) WHERE state <> 'deleted';
