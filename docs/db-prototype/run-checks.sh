#!/usr/bin/env bash
# Phase 6 design validation. Runs schema.sql + checks.sql in a throwaway PostGIS container,
# then a two-session concurrency test (BR-08). Requires Docker. Leaves nothing running.
set -euo pipefail
cd "$(dirname "$0")"
NAME="parkbro-dbproto-$$"
IMAGE="${IMAGE:-postgis/postgis:17-3.5}"
PLATFORM="${PLATFORM:-linux/amd64}"   # official image is amd64-only; runs under emulation on Apple Silicon
TMP="$(mktemp -d)"
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT

docker run -d --platform "$PLATFORM" --name "$NAME" -e POSTGRES_PASSWORD=proto -e POSTGRES_DB=proto "$IMAGE" >/dev/null
# The image first runs a temporary init server (which pg_isready also reports as ready), then restarts.
# Wait for the final server: "init process complete" followed by "ready to accept connections".
for _ in $(seq 1 120); do
  docker logs "$NAME" 2>&1 | sed -n '/init process complete/,$p' | grep -q "ready to accept connections" && break
  sleep 1
done
PSQL=(docker exec -i "$NAME" psql -U postgres -d proto -v ON_ERROR_STOP=1 -q)

"${PSQL[@]}" < schema.sql 2>&1 | grep -v "already exists, skipping" || true
"${PSQL[@]}" < checks.sql 2>&1 | sed -En 's/^.*NOTICE:  ((PASS|FAIL).*)/\1/p; s/^ *(Index Scan|Bitmap Index Scan|Seq Scan)(.*)/C13 plan: \1\2/p'

# C15 (BR-08 under real concurrency): two sessions insert overlapping bookings for one unit at the same time.
# Session A holds its uncommitted insert for 3 s; session B's insert must block, then fail when A commits.
BOOK="INSERT INTO booking.bookings (customer_id, asset_id, unit_id, property_id, mode, period, status, total_paise, idempotency_key)
      VALUES ('00000000-0000-0000-0000-0000000000c%s','00000000-0000-0000-0000-00000000a003','00000000-0000-0000-0000-0000000b0004',
              '00000000-0000-0000-0000-0000000000a2','HOURLY', tstzrange('2026-12-01 10:00+05:30','2026-12-01 12:00+05:30'),'CONFIRMED',100,'race-%s');"
( printf "BEGIN; $BOOK SELECT pg_sleep(3); COMMIT;" 1 A | "${PSQL[@]}" >"$TMP/a" 2>&1; echo "A exit $?" >>"$TMP/a" ) &
sleep 1
START=$(date +%s)
set +e
printf "$BOOK" 2 B | "${PSQL[@]}" >"$TMP/b" 2>&1; B_EXIT=$?
set -e
WAITED=$(( $(date +%s) - START ))
wait
COUNT=$("${PSQL[@]}" -tAc "select count(*) from booking.bookings where idempotency_key like 'race-%'")
if [[ $B_EXIT -ne 0 && "$COUNT" == "1" && $WAITED -ge 1 ]] && grep -q "bookings_no_overlap" "$TMP/b"; then
  echo "PASS C15 concurrent overlapping inserts: B blocked ${WAITED}s on A, then failed on bookings_no_overlap; exactly 1 booking"
else
  echo "FAIL C15 B_EXIT=$B_EXIT COUNT=$COUNT WAITED=$WAITED"; cat "$TMP/a" "$TMP/b"
fi

# C16 (BR-06, R-39 under real concurrency): property a1 has outsider_cap = 2 and already one holding booking.
# Sessions A and B each lock the property row, check max concurrency < cap, then insert on different units.
# Without the lock both would see 1 and both succeed (cap breached). With the lock, B waits, sees 2, and refuses.
"${PSQL[@]}" -c "INSERT INTO booking.bookings (customer_id, asset_id, unit_id, property_id, mode, period, status, total_paise, idempotency_key)
  VALUES ('00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-00000000a001','00000000-0000-0000-0000-0000000b0001',
          '00000000-0000-0000-0000-0000000000a1','HOURLY', tstzrange('2026-12-05 10:00+05:30','2026-12-05 12:00+05:30'),'CONFIRMED',100,'cap-pre');"
CAPTX="BEGIN;
  SELECT 1 FROM properties.properties WHERE id = '00000000-0000-0000-0000-0000000000a1' FOR UPDATE;
  DO \$\$ BEGIN
    IF booking.max_concurrent_in_property('00000000-0000-0000-0000-0000000000a1',
         tstzrange('2026-12-05 10:00+05:30','2026-12-05 12:00+05:30')) >= 2 THEN
      RAISE EXCEPTION 'property cap reached';
    END IF;
  END \$\$;
  INSERT INTO booking.bookings (customer_id, asset_id, unit_id, property_id, mode, period, status, total_paise, idempotency_key)
  VALUES ('00000000-0000-0000-0000-0000000000c2','00000000-0000-0000-0000-00000000a002','00000000-0000-0000-0000-0000000b000%s',
          '00000000-0000-0000-0000-0000000000a1','HOURLY', tstzrange('2026-12-05 10:00+05:30','2026-12-05 12:00+05:30'),'CONFIRMED',100,'cap-%s');
  SELECT pg_sleep(%s);
COMMIT;"
( printf "$CAPTX" 2 A 3 | "${PSQL[@]}" >"$TMP/ca" 2>&1 ) &
sleep 1
set +e
printf "$CAPTX" 3 B 0 | "${PSQL[@]}" >"$TMP/cb" 2>&1; CB_EXIT=$?
set -e
wait
CAPCOUNT=$("${PSQL[@]}" -tAc "select count(*) from booking.bookings where idempotency_key like 'cap-%'")
if [[ $CB_EXIT -ne 0 && "$CAPCOUNT" == "2" ]] && grep -q "property cap reached" "$TMP/cb"; then
  echo "PASS C16 concurrent bookings under property cap: B serialised behind A and refused; cap of 2 held"
else
  echo "FAIL C16 CB_EXIT=$CB_EXIT CAPCOUNT=$CAPCOUNT"; cat "$TMP/ca" "$TMP/cb"
fi

# C16-control: identical race WITHOUT the property lock must breach the cap. Proves C16 is not vacuous
# and that per-unit constraints alone cannot enforce BR-06 (R-39).
NOLOCK=$(printf '%s' "$CAPTX" | sed "/FOR UPDATE;/d; s/2026-12-05/2026-12-06/g; s/'cap-%s'/'nolock-%s'/")
"${PSQL[@]}" -c "INSERT INTO booking.bookings (customer_id, asset_id, unit_id, property_id, mode, period, status, total_paise, idempotency_key)
  VALUES ('00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-00000000a001','00000000-0000-0000-0000-0000000b0001',
          '00000000-0000-0000-0000-0000000000a1','HOURLY', tstzrange('2026-12-06 10:00+05:30','2026-12-06 12:00+05:30'),'CONFIRMED',100,'nolock-pre');"
( printf "$NOLOCK" 2 A 3 | "${PSQL[@]}" >/dev/null 2>&1 ) &
sleep 1
printf "$NOLOCK" 3 B 0 | "${PSQL[@]}" >/dev/null 2>&1 || true
wait
NL=$("${PSQL[@]}" -tAc "select count(*) from booking.bookings where idempotency_key like 'nolock-%'")
if [[ "$NL" == "3" ]]; then
  echo "PASS C16-control without the property lock the cap of 2 is breached (3 bookings): the lock is required"
else
  echo "FAIL C16-control expected 3 bookings without lock, got $NL"
fi
