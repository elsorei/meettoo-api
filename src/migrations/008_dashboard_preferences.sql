-- Dashboard preferences for users
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='dashboard_preferences') THEN
    ALTER TABLE users ADD COLUMN dashboard_preferences JSONB NOT NULL DEFAULT '{}';
  END IF;
END $$;
