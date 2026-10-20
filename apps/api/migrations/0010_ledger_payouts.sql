-- 0010 ledger and payouts (Phase 16; business-model §2–3; domain-model §5.6, BR-18, BR-19; database-design §8;
-- D-128..). Customer payment, platform commission, fees/taxes, host earnings and payouts are separate ledger
-- concepts. Double entry: every journal balances (deferred trigger) and entries are append-only.
CREATE SCHEMA ledger;
CREATE SCHEMA payouts;

CREATE TABLE ledger.accounts (
  id         uuid PRIMARY KEY,
  code       text NOT NULL CHECK (code IN (
               'CUSTOMER_CLEARING',      -- money collected through the payment provider (platform asset)
               'PLATFORM_SERVICE_FEE',   -- revenue: customer service fee
               'PLATFORM_COMMISSION',    -- revenue: host commission
               'TAX_PAYABLE',            -- liability: taxes on platform revenue (rate pending CA review, R-70)
               'HOST_PENDING',           -- liability: earned, not yet releasable (BR-18)
               'HOST_AVAILABLE',         -- liability: releasable to the host
               'HOST_IN_PAYOUT',         -- liability: in a payout being sent
               'HOST_RECEIVABLE',        -- asset: host owes the platform (refund after payout, BR-19)
               'PAYOUT_CASH')),          -- platform bank outflow for payouts
  owner_kind text NOT NULL CHECK (owner_kind IN ('PLATFORM', 'HOST')),
  owner_id   uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((owner_kind = 'HOST') = (owner_id IS NOT NULL)),
  UNIQUE NULLS NOT DISTINCT (code, owner_kind, owner_id)
);

CREATE TABLE ledger.journals (
  id              uuid PRIMARY KEY,
  kind            text NOT NULL CHECK (kind IN ('PAYMENT_CAPTURED', 'REFUND', 'EARNINGS_RELEASED', 'PAYOUT_CREATED',
                    'PAYOUT_PAID', 'PAYOUT_FAILED', 'RECEIVABLE_OFFSET')),
  booking_id      uuid REFERENCES booking.bookings (id),
  payment_id      uuid REFERENCES payments.payments (id),
  refund_id       uuid REFERENCES payments.refunds (id),
  payout_id       uuid,                                     -- FK added below (payouts table)
  host_account_id uuid REFERENCES identity.host_accounts (id),
  memo            text,
  idempotency_key text NOT NULL UNIQUE,                     -- e.g. payment:<id>:capture — retries never double-post
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX journals_booking_ix ON ledger.journals (booking_id) WHERE booking_id IS NOT NULL;
CREATE INDEX journals_host_ix ON ledger.journals (host_account_id, created_at) WHERE host_account_id IS NOT NULL;

CREATE TABLE ledger.entries (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  journal_id   uuid NOT NULL REFERENCES ledger.journals (id),
  account_id   uuid NOT NULL REFERENCES ledger.accounts (id),
  direction    text NOT NULL CHECK (direction IN ('DEBIT', 'CREDIT')),
  amount_paise bigint NOT NULL CHECK (amount_paise > 0),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX entries_account_ix ON ledger.entries (account_id, created_at);
CREATE INDEX entries_journal_ix ON ledger.entries (journal_id);

CREATE FUNCTION ledger.check_journal_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE diff bigint; n integer;
BEGIN
  SELECT coalesce(sum(CASE direction WHEN 'DEBIT' THEN amount_paise ELSE -amount_paise END), 0), count(*)
    INTO diff, n FROM ledger.entries WHERE journal_id = NEW.journal_id;
  IF diff <> 0 OR n < 2 THEN
    RAISE EXCEPTION 'journal % is not balanced (difference %, % entries)', NEW.journal_id, diff, n USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER entries_balanced AFTER INSERT ON ledger.entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger.check_journal_balanced();
CREATE TRIGGER entries_append_only BEFORE UPDATE OR DELETE ON ledger.entries FOR EACH ROW EXECUTE FUNCTION platform.forbid_mutation();
CREATE TRIGGER journals_append_only BEFORE UPDATE OR DELETE ON ledger.journals FOR EACH ROW EXECUTE FUNCTION platform.forbid_mutation();

-- ------------------------------------------------------------------ payouts
CREATE TABLE payouts.payout_accounts (
  id               uuid PRIMARY KEY,
  host_account_id  uuid NOT NULL REFERENCES identity.host_accounts (id),
  method           text NOT NULL CHECK (method IN ('UPI', 'BANK')),
  holder_name      text NOT NULL CHECK (char_length(holder_name) BETWEEN 2 AND 100),
  details_enc      bytea NOT NULL,                          -- VPA, or account number + IFSC (field cipher)
  display_last4    text NOT NULL CHECK (char_length(display_last4) BETWEEN 2 AND 8),
  ifsc             text CHECK (ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
  status           text NOT NULL CHECK (status IN ('PENDING_VERIFICATION', 'VERIFIED', 'REJECTED', 'REPLACED')),
  verified_at      timestamptz,
  verified_by      uuid REFERENCES identity.users (id),
  hold_until       timestamptz,                             -- 72 h after a change of account (R-17)
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((method = 'BANK') = (ifsc IS NOT NULL)),
  CHECK (status <> 'VERIFIED' OR verified_at IS NOT NULL)
);
CREATE UNIQUE INDEX payout_accounts_current_uq ON payouts.payout_accounts (host_account_id)
  WHERE status IN ('PENDING_VERIFICATION', 'VERIFIED');
CREATE TRIGGER payout_accounts_touch BEFORE UPDATE ON payouts.payout_accounts FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();

CREATE TABLE payouts.payouts (
  id                uuid PRIMARY KEY,
  host_account_id   uuid NOT NULL REFERENCES identity.host_accounts (id),
  payout_account_id uuid NOT NULL REFERENCES payouts.payout_accounts (id),
  amount_paise      bigint NOT NULL CHECK (amount_paise > 0),
  status            text NOT NULL CHECK (status IN ('PROCESSING', 'PAID', 'FAILED')),
  provider          text NOT NULL CHECK (provider IN ('MANUAL')),
  provider_reference text CHECK (char_length(provider_reference) <= 100),   -- bank UTR / provider payout id
  failure_reason    text CHECK (char_length(failure_reason) <= 300),
  idempotency_key   text NOT NULL UNIQUE,                   -- payout-run:<date>:<host>
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  settled_at        timestamptz,
  settled_by        uuid REFERENCES identity.users (id),
  CHECK (status <> 'PAID' OR provider_reference IS NOT NULL)
);
CREATE UNIQUE INDEX payouts_open_uq ON payouts.payouts (host_account_id) WHERE status = 'PROCESSING';
CREATE INDEX payouts_host_ix ON payouts.payouts (host_account_id, created_at DESC);
CREATE TRIGGER payouts_touch BEFORE UPDATE ON payouts.payouts FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();

ALTER TABLE ledger.journals ADD CONSTRAINT journals_payout_fk FOREIGN KEY (payout_id) REFERENCES payouts.payouts (id);
