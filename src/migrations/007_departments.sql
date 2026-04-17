-- Departments table and operator assignment
CREATE TABLE IF NOT EXISTS departments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(100) NOT NULL,
  description TEXT,
  color       VARCHAR(7) DEFAULT '#6c757d',
  sort_order  INT NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Add department_id to operators if not exists
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='operators' AND column_name='department_id') THEN
    ALTER TABLE operators ADD COLUMN department_id UUID REFERENCES departments(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Seed default departments
INSERT INTO departments (name, description, color, sort_order) VALUES
  ('Team Fiscale', 'Area fiscale e tributaria', '#007bff', 1),
  ('Team Lavoro', 'Area consulenza del lavoro e paghe', '#28a745', 2),
  ('Team Amministrazione', 'Area amministrativa e contabile', '#ffc107', 3)
ON CONFLICT DO NOTHING;
