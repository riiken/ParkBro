-- 0012 notifications (Phase 18; ux-architecture §12; architecture §5 "MessagingProvider"; D-143..). Each row is one
-- message to one recipient on one channel. Rows are written in the same transaction as the event that causes them
-- (they are the transactional outbox, D-101) and delivered by a worker with retries.
CREATE SCHEMA notifications;

CREATE TABLE notifications.notifications (
  id                  uuid PRIMARY KEY,
  user_id             uuid NOT NULL REFERENCES identity.users (id),
  template            text NOT NULL CHECK (char_length(template) <= 60),
  category            text NOT NULL CHECK (category IN ('CRITICAL', 'TRANSACTIONAL', 'REMINDER')),
  channel             text NOT NULL CHECK (channel IN ('IN_APP', 'PUSH', 'SMS', 'WHATSAPP', 'EMAIL')),
  vars                jsonb NOT NULL DEFAULT '{}',        -- template variables; never phone numbers, codes or addresses
  link                text CHECK (char_length(link) <= 200),
  dedupe_key          text NOT NULL UNIQUE,               -- event + recipient + channel: an event notifies once
  status              text NOT NULL CHECK (status IN ('PENDING', 'SENDING', 'SENT', 'DELIVERED', 'FAILED', 'SUPPRESSED')),
  suppressed_reason   text,
  attempts            integer NOT NULL DEFAULT 0,
  next_attempt_at     timestamptz NOT NULL DEFAULT now(),
  claimed_at          timestamptz,                        -- SENDING lease
  provider            text,
  provider_message_id text,
  last_error          text CHECK (char_length(last_error) <= 300),
  sent_at             timestamptz,
  delivered_at        timestamptz,
  read_at             timestamptz,                        -- in-app inbox
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'SUPPRESSED') = (suppressed_reason IS NOT NULL))
);
CREATE INDEX notifications_due_ix ON notifications.notifications (next_attempt_at) WHERE status IN ('PENDING', 'SENDING');
CREATE INDEX notifications_inbox_ix ON notifications.notifications (user_id, created_at DESC) WHERE channel = 'IN_APP';
CREATE UNIQUE INDEX notifications_provider_msg_uq ON notifications.notifications (provider, provider_message_id)
  WHERE provider_message_id IS NOT NULL;
CREATE TRIGGER notifications_touch BEFORE UPDATE ON notifications.notifications FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();

-- Opt-outs per channel for non-critical messages. Absent row = enabled.
CREATE TABLE notifications.preferences (
  user_id    uuid NOT NULL REFERENCES identity.users (id),
  channel    text NOT NULL CHECK (channel IN ('PUSH', 'SMS', 'WHATSAPP', 'EMAIL')),
  enabled    boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, channel)
);
