-- Custom migration: keep updated_at fresh on UPDATE for tables that have it.

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON "users"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

CREATE TRIGGER clients_set_updated_at
  BEFORE UPDATE ON "clients"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

CREATE TRIGGER sessions_set_updated_at
  BEFORE UPDATE ON "sessions"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
