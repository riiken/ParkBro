-- 0016 pilot customer clearance (Phase 23; D-168; R-62). Until KYC/RC verification providers exist, a controlled
-- pilot admits customers after a manual trust & safety check (vehicle RC and ID seen offline). Recorded as a
-- verification record (append-only history; latest wins) so it becomes V-VEHICLE-RC / V-ID when providers arrive.
ALTER TABLE trust.verification_records DROP CONSTRAINT verification_records_kind_check;
ALTER TABLE trust.verification_records ADD CONSTRAINT verification_records_kind_check
  CHECK (kind IN ('RIGHT_TO_RENT', 'CHARGER_SAFETY', 'SOCIETY_CONSENT', 'PHOTO_REVIEW', 'SITE_VISIT', 'PILOT_CLEARANCE'));
