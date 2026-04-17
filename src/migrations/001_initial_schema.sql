-- Studio REI API - Initial Schema
-- PostgreSQL 16

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================
-- USERS & AUTH
-- ============================================

CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username        VARCHAR(100) UNIQUE NOT NULL,
  password_hash   VARCHAR(255) NOT NULL,
  password_version SMALLINT NOT NULL DEFAULT 2,  -- 1=SHA256 legacy, 2=bcrypt
  role            VARCHAR(20) NOT NULL CHECK (role IN ('client','operator','admin','owner')),
  is_active       BOOLEAN NOT NULL DEFAULT true,
  fcm_token       VARCHAR(500),
  last_login      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================
-- CLIENTS
-- ============================================

CREATE TABLE client_types (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(100) NOT NULL,
  description TEXT
);

CREATE TABLE clients (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  legacy_code     VARCHAR(50),
  business_name   VARCHAR(255) NOT NULL,
  fiscal_code     VARCHAR(16),
  vat_number      VARCHAR(11),
  primary_email   VARCHAR(255) NOT NULL,
  modules         JSONB NOT NULL DEFAULT '{}',
  metadata        JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_clients_fiscal_code ON clients(fiscal_code) WHERE fiscal_code IS NOT NULL;
CREATE INDEX idx_clients_user_id ON clients(user_id);
CREATE INDEX idx_clients_legacy_code ON clients(legacy_code) WHERE legacy_code IS NOT NULL;

CREATE TABLE client_emails (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  email     VARCHAR(255) NOT NULL
);

CREATE TABLE client_type_assignments (
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  type_id   INT NOT NULL REFERENCES client_types(id) ON DELETE CASCADE,
  PRIMARY KEY (client_id, type_id)
);

-- ============================================
-- OPERATORS
-- ============================================

CREATE TABLE operators (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email            VARCHAR(255) UNIQUE NOT NULL,
  first_name       VARCHAR(100) NOT NULL,
  last_name        VARCHAR(100) NOT NULL,
  department       VARCHAR(100),
  is_admin         BOOLEAN NOT NULL DEFAULT false,
  is_owner         BOOLEAN NOT NULL DEFAULT false,
  gcalendar_tokens JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_operators_user_id ON operators(user_id);

CREATE TABLE calendar_permissions (
  owner_operator_id   UUID NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  viewer_operator_id  UUID NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  can_edit            BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (owner_operator_id, viewer_operator_id)
);

-- ============================================
-- EVENTS (unified: appointment + commitment + reminder)
-- ============================================

CREATE TABLE events (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type                  VARCHAR(20) NOT NULL CHECK (type IN ('appointment','commitment','reminder')),
  title                 VARCHAR(500) NOT NULL,
  description           TEXT,
  event_date            DATE NOT NULL,
  start_time            TIME,
  end_time              TIME,
  status                VARCHAR(20) NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','confirmed','cancelled','suspended','completed')),
  has_alarm             BOOLEAN NOT NULL DEFAULT false,
  alarm_datetime        TIMESTAMPTZ,
  alarm_dismissed       BOOLEAN NOT NULL DEFAULT false,
  confirmation_deadline TIMESTAMPTZ,
  owner_id              UUID NOT NULL REFERENCES users(id),
  gcalendar_event_id    VARCHAR(255),
  gcalendar_synced_at   TIMESTAMPTZ,
  metadata              JSONB NOT NULL DEFAULT '{}',
  closed                BOOLEAN NOT NULL DEFAULT false,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_events_date ON events(event_date);
CREATE INDEX idx_events_owner ON events(owner_id);
CREATE INDEX idx_events_type ON events(type);
CREATE INDEX idx_events_status ON events(status);
CREATE INDEX idx_events_gcal ON events(gcalendar_event_id) WHERE gcalendar_event_id IS NOT NULL;

CREATE TABLE event_participants (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id),
  role          VARCHAR(20) NOT NULL DEFAULT 'participant'
                CHECK (role IN ('organizer','participant')),
  confirmation  VARCHAR(20) NOT NULL DEFAULT 'pending'
                CHECK (confirmation IN ('pending','accepted','declined')),
  confirmed_at  TIMESTAMPTZ,
  notified      BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX idx_event_participants_user ON event_participants(user_id);
CREATE INDEX idx_event_participants_event ON event_participants(event_id);
CREATE UNIQUE INDEX idx_event_participants_unique ON event_participants(event_id, user_id);

CREATE TABLE event_attachments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  file_name   VARCHAR(255) NOT NULL,
  file_path   VARCHAR(500) NOT NULL,
  file_size   BIGINT,
  mime_type   VARCHAR(100),
  uploaded_by UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================
-- BLACKBOARD (real-time messaging)
-- ============================================

CREATE TABLE blackboard_channels (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(255),
  type        VARCHAR(20) NOT NULL CHECK (type IN ('direct','group','client_channel')),
  client_id   UUID REFERENCES clients(id) ON DELETE SET NULL,
  created_by  UUID REFERENCES users(id),
  is_archived BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_bb_channels_client ON blackboard_channels(client_id) WHERE client_id IS NOT NULL;

CREATE TABLE blackboard_members (
  channel_id UUID NOT NULL REFERENCES blackboard_channels(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       VARCHAR(20) NOT NULL DEFAULT 'member',
  joined_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (channel_id, user_id)
);

CREATE TABLE blackboard_messages (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id   UUID NOT NULL REFERENCES blackboard_channels(id) ON DELETE CASCADE,
  sender_id    UUID NOT NULL REFERENCES users(id),
  content      TEXT NOT NULL,
  message_type VARCHAR(20) NOT NULL DEFAULT 'text'
               CHECK (message_type IN ('text','file','system')),
  file_url     VARCHAR(500),
  edited_at    TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_bb_messages_channel ON blackboard_messages(channel_id, created_at DESC);

CREATE TABLE blackboard_read_receipts (
  message_id UUID NOT NULL REFERENCES blackboard_messages(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (message_id, user_id)
);

-- ============================================
-- COMMUNICATIONS (studio → client, one-way)
-- ============================================

CREATE TABLE communications (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject    VARCHAR(500) NOT NULL,
  content    TEXT NOT NULL,
  sender_id  UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE communication_recipients (
  communication_id UUID NOT NULL REFERENCES communications(id) ON DELETE CASCADE,
  client_id        UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  read             BOOLEAN NOT NULL DEFAULT false,
  read_at          TIMESTAMPTZ,
  PRIMARY KEY (communication_id, client_id)
);

CREATE TABLE communication_attachments (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  communication_id UUID NOT NULL REFERENCES communications(id) ON DELETE CASCADE,
  file_name        VARCHAR(255) NOT NULL,
  file_path        VARCHAR(500) NOT NULL,
  file_size        BIGINT
);

-- ============================================
-- DOCUMENTS
-- ============================================

CREATE TABLE documents (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_name     VARCHAR(255) NOT NULL,
  file_path     VARCHAR(500) NOT NULL,
  file_size     BIGINT,
  mime_type     VARCHAR(100),
  uploaded_by   UUID NOT NULL REFERENCES users(id),
  client_id     UUID NOT NULL REFERENCES clients(id),
  downloaded    BOOLEAN NOT NULL DEFAULT false,
  downloaded_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_documents_client ON documents(client_id);

-- ============================================
-- TODO LIST
-- ============================================

CREATE TABLE todos (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  text         TEXT NOT NULL,
  due_date     DATE,
  due_time     TIME,
  is_completed BOOLEAN NOT NULL DEFAULT false,
  completed_at TIMESTAMPTZ,
  position     INT NOT NULL DEFAULT 0,
  owner_id     UUID NOT NULL REFERENCES users(id),
  assigned_to  UUID REFERENCES users(id),
  module_ref   VARCHAR(100),
  module_data  JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_todos_owner ON todos(owner_id);
CREATE INDEX idx_todos_assigned ON todos(assigned_to) WHERE assigned_to IS NOT NULL;

-- ============================================
-- NOTIFICATIONS
-- ============================================

CREATE TABLE notifications (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       VARCHAR(50) NOT NULL,
  title      VARCHAR(255),
  body       TEXT,
  data       JSONB NOT NULL DEFAULT '{}',
  read       BOOLEAN NOT NULL DEFAULT false,
  read_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_notifications_user ON notifications(user_id, read, created_at DESC);

-- ============================================
-- NEWS
-- ============================================

CREATE TABLE news (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title        VARCHAR(500) NOT NULL,
  content      TEXT,
  is_published BOOLEAN NOT NULL DEFAULT false,
  is_draft     BOOLEAN NOT NULL DEFAULT true,
  published_at TIMESTAMPTZ,
  author_id    UUID NOT NULL REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE news_attachments (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  news_id   UUID NOT NULL REFERENCES news(id) ON DELETE CASCADE,
  url       VARCHAR(500),
  file_name VARCHAR(255)
);

-- ============================================
-- DEADLINES (scadenzario)
-- ============================================

CREATE TABLE deadlines (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title       VARCHAR(255) NOT NULL,
  description TEXT,
  due_date    DATE NOT NULL,
  type        VARCHAR(50),
  created_by  UUID NOT NULL REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_deadlines_date ON deadlines(due_date);

-- ============================================
-- MODULE SYSTEM (plugin architecture)
-- ============================================

CREATE TABLE modules (
  id          VARCHAR(50) PRIMARY KEY,
  name        VARCHAR(255) NOT NULL,
  description TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  config      JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE client_modules (
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  module_id VARCHAR(50) NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  enabled   BOOLEAN NOT NULL DEFAULT true,
  config    JSONB NOT NULL DEFAULT '{}',
  PRIMARY KEY (client_id, module_id)
);
