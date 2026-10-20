-- 0001 platform_foundation: extensions and shared helpers used by every module schema.
-- See docs/database-design.md §1 (conventions), §6 (btree_gist for exclusion constraints), §10 (append-only).

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS platform;

-- Keeps updated_at current on mutable tables: CREATE TRIGGER ... BEFORE UPDATE ... EXECUTE FUNCTION platform.touch_updated_at()
CREATE FUNCTION platform.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- Guards append-only tables (history, ledger entries, audit): BEFORE UPDATE OR DELETE ... EXECUTE FUNCTION platform.forbid_mutation()
CREATE FUNCTION platform.forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%.% is append-only', TG_TABLE_SCHEMA, TG_TABLE_NAME;
END $$;
