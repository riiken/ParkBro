-- Phase 6 design checks, run against schema.sql by run-checks.sh. Each block prints PASS or FAIL.
SET client_min_messages = notice;

-- ---------------------------------------------------------------- fixtures
INSERT INTO identity.users (id, phone_enc, phone_hmac) VALUES
 ('00000000-0000-0000-0000-0000000000c1', 'x', 'h1'),
 ('00000000-0000-0000-0000-0000000000c2', 'x', 'h2');
INSERT INTO properties.properties (id, kind, exact_address_enc, exact_point_enc, public_point, area_label, participation_status, outsider_cap) VALUES
 ('00000000-0000-0000-0000-0000000000a1', 'APARTMENT_SOCIETY', 'x', 'x', 'SRID=4326;POINT(77.6245 12.9352)', 'Koramangala', 'PARTICIPATING', 2),
 ('00000000-0000-0000-0000-0000000000a2', 'COMMERCIAL',        'x', 'x', 'SRID=4326;POINT(77.6400 12.9700)', 'Indiranagar', 'NOT_REQUIRED', NULL);
INSERT INTO assets.assets (id, property_id, asset_type, status, buffer_minutes) VALUES
 ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000000a1', 'PARKING', 'PUBLISHED', 15),
 ('00000000-0000-0000-0000-00000000a002', '00000000-0000-0000-0000-0000000000a1', 'PARKING', 'PUBLISHED', 0),
 ('00000000-0000-0000-0000-00000000a003', '00000000-0000-0000-0000-0000000000a2', 'PARKING', 'PUBLISHED', 0);
INSERT INTO assets.asset_units (id, asset_id, label) VALUES
 ('00000000-0000-0000-0000-0000000b0001', '00000000-0000-0000-0000-00000000a001', 'B2-14'),
 ('00000000-0000-0000-0000-0000000b0002', '00000000-0000-0000-0000-00000000a002', 'B2-15'),
 ('00000000-0000-0000-0000-0000000b0003', '00000000-0000-0000-0000-00000000a002', 'B2-16'),
 ('00000000-0000-0000-0000-0000000b0004', '00000000-0000-0000-0000-00000000a003', 'S1');

-- helper: insert a booking (unit 1 = buffered asset in property a1)
CREATE FUNCTION pg_temp.book(p_unit text, p_asset text, p_prop text, p_from text, p_to text,
                             p_status text, p_key text, p_customer text DEFAULT 'c1',
                             p_buffer int DEFAULT 0, p_expires interval DEFAULT interval '10 minutes')
RETURNS uuid LANGUAGE sql AS $$
  INSERT INTO booking.bookings (customer_id, asset_id, unit_id, property_id, mode, period, buffer_minutes,
                                status, hold_expires_at, total_paise, idempotency_key)
  VALUES (('00000000-0000-0000-0000-0000000000' || p_customer)::uuid,
          ('00000000-0000-0000-0000-00000000' || p_asset)::uuid,
          ('00000000-0000-0000-0000-0000000b' || p_unit)::uuid,
          ('00000000-0000-0000-0000-0000000000' || p_prop)::uuid,
          'HOURLY', tstzrange(p_from::timestamptz, p_to::timestamptz, '[)'), p_buffer,
          p_status, CASE WHEN p_status = 'PENDING_PAYMENT' THEN now() + p_expires END, 10000, p_key)
  RETURNING id
$$;

-- C1 (BR-08): overlapping booking on the same unit is rejected by the exclusion constraint
DO $$ BEGIN
  PERFORM pg_temp.book('0004','a003','a2','2026-11-02 10:00+05:30','2026-11-02 12:00+05:30','CONFIRMED','k1');
  BEGIN
    PERFORM pg_temp.book('0004','a003','a2','2026-11-02 11:00+05:30','2026-11-02 13:00+05:30','CONFIRMED','k2','c2');
    RAISE NOTICE 'FAIL C1 overlap accepted';
  EXCEPTION WHEN exclusion_violation THEN RAISE NOTICE 'PASS C1 overlapping booking rejected (exclusion_violation)';
  END;
END $$;

-- C2 (BR-02): adjacent booking with zero buffer is allowed
DO $$ BEGIN
  PERFORM pg_temp.book('0004','a003','a2','2026-11-02 12:00+05:30','2026-11-02 14:00+05:30','CONFIRMED','k3','c2');
  RAISE NOTICE 'PASS C2 adjacent booking (10-12, 12-14) accepted with buffer 0';
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'FAIL C2 adjacent rejected: %', SQLERRM; END $$;

-- C3 (BR-02 + buffer): with a 15-min buffer, a booking at end+10 min is rejected, at end+15 min accepted
DO $$ BEGIN
  PERFORM pg_temp.book('0001','a001','a1','2026-11-03 08:00+05:30','2026-11-03 10:00+05:30','CONFIRMED','k4','c1',15);
  BEGIN
    PERFORM pg_temp.book('0001','a001','a1','2026-11-03 10:10+05:30','2026-11-03 11:00+05:30','CONFIRMED','k5','c2',15);
    RAISE NOTICE 'FAIL C3 booking inside buffer accepted';
  EXCEPTION WHEN exclusion_violation THEN NULL; END;
  PERFORM pg_temp.book('0001','a001','a1','2026-11-03 10:15+05:30','2026-11-03 11:00+05:30','CONFIRMED','k6','c2',15);
  RAISE NOTICE 'PASS C3 buffer enforced (10:10 rejected, 10:15 accepted)';
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'FAIL C3 %', SQLERRM; END $$;

-- C4 (BR-10, R-40): a lapsed PENDING_PAYMENT hold still blocks at constraint level until expired in-transaction;
--                   the booking transaction expires it, then the new booking succeeds
DO $$ DECLARE n int; BEGIN
  PERFORM pg_temp.book('0004','a003','a2','2026-11-04 10:00+05:30','2026-11-04 12:00+05:30','PENDING_PAYMENT','k7','c1',0, interval '-1 minute');
  BEGIN
    PERFORM pg_temp.book('0004','a003','a2','2026-11-04 10:00+05:30','2026-11-04 12:00+05:30','PENDING_PAYMENT','k8','c2');
    RAISE NOTICE 'FAIL C4a lapsed hold did not block (unexpected)';
  EXCEPTION WHEN exclusion_violation THEN NULL; END;
  -- the booking transaction's "expire lapsed overlapping holds" step:
  UPDATE booking.bookings SET status = 'EXPIRED'
   WHERE unit_id = '00000000-0000-0000-0000-0000000b0004' AND status = 'PENDING_PAYMENT'
     AND hold_expires_at < now() AND blocked_period && tstzrange('2026-11-04 10:00+05:30','2026-11-04 12:00+05:30');
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM pg_temp.book('0004','a003','a2','2026-11-04 10:00+05:30','2026-11-04 12:00+05:30','PENDING_PAYMENT','k8','c2');
  RAISE NOTICE 'PASS C4 lapsed hold expired in-transaction (% row) and unit re-booked', n;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'FAIL C4 %', SQLERRM; END $$;

-- C5 (BR-09): same customer + idempotency key cannot create a second booking
DO $$ BEGIN
  PERFORM pg_temp.book('0004','a003','a2','2026-11-05 10:00+05:30','2026-11-05 11:00+05:30','CONFIRMED','k1','c1');
  RAISE NOTICE 'FAIL C5 duplicate idempotency key accepted';
EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'PASS C5 duplicate idempotency key rejected'; END $$;

-- C6: terminal (non-holding) bookings do not block the unit
DO $$ DECLARE b uuid; BEGIN
  b := pg_temp.book('0004','a003','a2','2026-11-06 10:00+05:30','2026-11-06 12:00+05:30','CONFIRMED','k9','c1');
  UPDATE booking.bookings SET status = 'CANCELLED' WHERE id = b;
  PERFORM pg_temp.book('0004','a003','a2','2026-11-06 10:00+05:30','2026-11-06 12:00+05:30','CONFIRMED','k10','c2');
  RAISE NOTICE 'PASS C6 cancelled booking frees the unit';
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'FAIL C6 %', SQLERRM; END $$;

-- C7: half-open ranges are enforced (inclusive upper bound rejected; empty range rejected)
DO $$ BEGIN
  BEGIN
    INSERT INTO booking.bookings (customer_id, asset_id, unit_id, property_id, mode, period, status, total_paise, idempotency_key)
    VALUES ('00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-00000000a003','00000000-0000-0000-0000-0000000b0004',
            '00000000-0000-0000-0000-0000000000a2','HOURLY', tstzrange('2026-11-07 10:00+05:30','2026-11-07 11:00+05:30','[]'),
            'CONFIRMED', 100, 'k11');
    RAISE NOTICE 'FAIL C7 closed range accepted';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS C7 non half-open range rejected'; END;
END $$;

-- C8 (BR-06): property cap = 2 uses MAX simultaneous bookings, not total overlapping bookings
DO $$ DECLARE m int; BEGIN
  -- property a1, units 0002/0003 (asset a002, buffer 0) and 0001 (asset a001)
  PERFORM pg_temp.book('0002','a002','a1','2026-11-10 09:00+05:30','2026-11-10 10:00+05:30','CONFIRMED','k20','c1');
  PERFORM pg_temp.book('0003','a002','a1','2026-11-10 11:00+05:30','2026-11-10 12:00+05:30','CONFIRMED','k21','c2');
  m := booking.max_concurrent_in_property('00000000-0000-0000-0000-0000000000a1', tstzrange('2026-11-10 08:00+05:30','2026-11-10 13:00+05:30'));
  IF m = 1 THEN RAISE NOTICE 'PASS C8a two non-simultaneous bookings count as max 1 concurrent';
  ELSE RAISE NOTICE 'FAIL C8a max concurrent = % (expected 1)', m; END IF;
  PERFORM pg_temp.book('0003','a002','a1','2026-11-10 09:30+05:30','2026-11-10 10:30+05:30','CONFIRMED','k22','c2');
  m := booking.max_concurrent_in_property('00000000-0000-0000-0000-0000000000a1', tstzrange('2026-11-10 08:00+05:30','2026-11-10 13:00+05:30'));
  IF m = 2 THEN RAISE NOTICE 'PASS C8b overlapping 09:00-10:00 and 09:30-10:30 count as max 2 (cap reached for a 3rd at 09:45)';
  ELSE RAISE NOTICE 'FAIL C8b max concurrent = % (expected 2)', m; END IF;
END $$;

-- C9 (D-016): unbalanced ledger journal is rejected at commit (deferred constraint trigger)
DO $$ DECLARE j uuid; a1 uuid; a2 uuid; BEGIN
  INSERT INTO ledger.accounts (code, owner_kind) VALUES ('customer_clearing','PLATFORM') RETURNING id INTO a1;
  INSERT INTO ledger.accounts (code, owner_kind) VALUES ('platform_revenue_commission','PLATFORM') RETURNING id INTO a2;
  INSERT INTO ledger.journals (kind) VALUES ('TEST') RETURNING id INTO j;
  INSERT INTO ledger.entries (journal_id, account_id, direction, amount_paise) VALUES (j, a1, 'DEBIT', 1000), (j, a2, 'CREDIT', 900);
  SET CONSTRAINTS ALL IMMEDIATE;
  RAISE NOTICE 'FAIL C9 unbalanced journal accepted';
EXCEPTION WHEN raise_exception THEN RAISE NOTICE 'PASS C9 unbalanced journal rejected (%)', SQLERRM; END $$;

-- C10: balanced journal accepted; ledger entries are append-only
DO $$ DECLARE j uuid; a1 uuid; a2 uuid; BEGIN
  SELECT id INTO a1 FROM ledger.accounts WHERE code = 'customer_clearing';
  IF a1 IS NULL THEN INSERT INTO ledger.accounts (code, owner_kind) VALUES ('customer_clearing','PLATFORM') RETURNING id INTO a1; END IF;
  INSERT INTO ledger.accounts (code, owner_kind) VALUES ('host_payable_pending','HOST') RETURNING id INTO a2;
  INSERT INTO ledger.journals (kind) VALUES ('TEST') RETURNING id INTO j;
  INSERT INTO ledger.entries (journal_id, account_id, direction, amount_paise) VALUES (j, a1, 'DEBIT', 1000), (j, a2, 'CREDIT', 1000);
  SET CONSTRAINTS ALL IMMEDIATE;
  BEGIN
    UPDATE ledger.entries SET amount_paise = 1 WHERE journal_id = j;
    RAISE NOTICE 'FAIL C10 ledger entry updated';
  EXCEPTION WHEN raise_exception THEN RAISE NOTICE 'PASS C10 balanced journal accepted; entries append-only'; END;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'FAIL C10 %', SQLERRM; END $$;

-- C11 (BR-15): duplicate provider webhook event is rejected
DO $$ BEGIN
  INSERT INTO payments.provider_events (provider, event_id, event_type, payload) VALUES ('razorpay','evt_1','payment.captured','{}');
  INSERT INTO payments.provider_events (provider, event_id, event_type, payload) VALUES ('razorpay','evt_1','payment.captured','{}');
  RAISE NOTICE 'FAIL C11 duplicate event accepted';
EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'PASS C11 duplicate provider event rejected'; END $$;

-- C12: an active plate cannot be registered twice; a removed one can be re-added
DO $$ BEGIN
  INSERT INTO users.vehicles (owner_id, plate_enc, plate_hmac, vehicle_class) VALUES ('00000000-0000-0000-0000-0000000000c1','x','p1','SEDAN');
  BEGIN
    INSERT INTO users.vehicles (owner_id, plate_enc, plate_hmac, vehicle_class) VALUES ('00000000-0000-0000-0000-0000000000c2','x','p1','SEDAN');
    RAISE NOTICE 'FAIL C12 duplicate active plate accepted';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  UPDATE users.vehicles SET status = 'REMOVED' WHERE plate_hmac = 'p1';
  INSERT INTO users.vehicles (owner_id, plate_enc, plate_hmac, vehicle_class) VALUES ('00000000-0000-0000-0000-0000000000c2','x','p1','SEDAN');
  RAISE NOTICE 'PASS C12 active-plate uniqueness (re-add after removal allowed)';
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'FAIL C12 %', SQLERRM; END $$;

-- C13 (geo): radius search on public points; and the query plan uses the GiST index
DO $$ DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM properties.properties
   WHERE ST_DWithin(public_point, 'SRID=4326;POINT(77.6250 12.9350)'::geography, 2000);
  IF n = 1 THEN RAISE NOTICE 'PASS C13 2 km radius returns only the nearby property';
  ELSE RAISE NOTICE 'FAIL C13 radius returned %', n; END IF;
END $$;
SET enable_seqscan = off;
EXPLAIN (COSTS OFF) SELECT id FROM properties.properties
 WHERE ST_DWithin(public_point, 'SRID=4326;POINT(77.6250 12.9350)'::geography, 2000);
RESET enable_seqscan;

-- C14: append-only booking history
DO $$ DECLARE b uuid; BEGIN
  SELECT id INTO b FROM booking.bookings LIMIT 1;
  INSERT INTO booking.booking_events (booking_id, from_status, to_status, actor_kind) VALUES (b, NULL, 'CONFIRMED', 'SYSTEM');
  DELETE FROM booking.booking_events WHERE booking_id = b;
  RAISE NOTICE 'FAIL C14 booking event deleted';
EXCEPTION WHEN raise_exception THEN RAISE NOTICE 'PASS C14 booking_events append-only'; END $$;
