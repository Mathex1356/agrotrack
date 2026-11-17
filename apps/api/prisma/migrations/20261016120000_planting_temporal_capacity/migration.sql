BEGIN;

-- Refuse incompatible existing facts; never rewrite agricultural history.
ALTER TABLE "Planting" ADD CONSTRAINT "Planting_lifecycle_check" CHECK (
  (status = 'PLANNED' AND "actualAreaHa" IS NULL AND "actualStartDate" IS NULL AND "actualEndDate" IS NULL)
  OR (status = 'IN_PROGRESS' AND "actualAreaHa" IS NOT NULL AND "actualStartDate" IS NOT NULL AND "actualEndDate" IS NULL)
  OR (status = 'FINISHED' AND "actualAreaHa" IS NOT NULL AND "actualStartDate" IS NOT NULL AND "actualEndDate" IS NOT NULL)
  OR (status = 'CANCELLED' AND (
    ("actualAreaHa" IS NULL AND "actualStartDate" IS NULL AND "actualEndDate" IS NULL)
    OR ("actualAreaHa" IS NOT NULL AND "actualStartDate" IS NOT NULL AND "actualEndDate" IS NOT NULL)))
);
ALTER TABLE "Planting" ADD CONSTRAINT "Planting_real_interval_check"
  CHECK ("actualEndDate" IS NULL OR "actualEndDate" > "actualStartDate");

-- VOLATILE deliberately obtains a current command snapshot under Read Committed.
-- Group equal dates BEFORE the running sum: end is the first unoccupied date.
-- No status filter: FINISHED and executed CANCELLED retain historical occupancy.
CREATE FUNCTION planting_occupation_peak(tenant uuid, farm uuid, field uuid)
RETURNS numeric LANGUAGE sql VOLATILE AS $$
  WITH events AS (
    SELECT "actualStartDate" AS day, "actualAreaHa" AS delta FROM "Planting"
    WHERE "organizationId" = tenant AND "farmId" = farm AND "fieldId" = field
      AND "actualAreaHa" IS NOT NULL AND "actualStartDate" IS NOT NULL
    UNION ALL
    SELECT "actualEndDate", -"actualAreaHa" FROM "Planting"
    WHERE "organizationId" = tenant AND "farmId" = farm AND "fieldId" = field
      AND "actualAreaHa" IS NOT NULL AND "actualEndDate" IS NOT NULL
  ), grouped AS (SELECT day, sum(delta) AS delta FROM events GROUP BY day),
  running AS (SELECT sum(delta) OVER (ORDER BY day ROWS UNBOUNDED PRECEDING) AS occupied FROM grouped)
  SELECT coalesce(max(occupied), 0::numeric) FROM running;
$$;

-- Preserve the existing tuple-version write, not just a row lock. A stale
-- Repeatable Read writer must abort rather than validate an obsolete snapshot.
CREATE OR REPLACE FUNCTION check_planting_individual_area() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE capacity numeric;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD."actualAreaHa" IS NOT NULL AND
       (NEW."actualAreaHa" IS NULL OR NEW."actualStartDate" IS NULL) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'Planting_execution_preserved',
        MESSAGE = 'Recorded planting occupation cannot be cleared';
    END IF;
    IF ROW(NEW."organizationId", NEW."farmId", NEW."fieldId", NEW."plannedAreaHa", NEW."actualAreaHa", NEW."actualStartDate", NEW."actualEndDate", NEW.status)
       IS NOT DISTINCT FROM
       ROW(OLD."organizationId", OLD."farmId", OLD."fieldId", OLD."plannedAreaHa", OLD."actualAreaHa", OLD."actualStartDate", OLD."actualEndDate", OLD.status) THEN
      RETURN NEW;
    END IF;
  END IF;
  UPDATE "Field" SET "areaHa" = "areaHa"
    WHERE "organizationId" = NEW."organizationId" AND "farmId" = NEW."farmId" AND id = NEW."fieldId"
    RETURNING "areaHa" INTO capacity;
  IF FOUND AND (NEW."plannedAreaHa" > capacity OR NEW."actualAreaHa" > capacity) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Planting exceeds individual field capacity';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION check_planting_temporal_capacity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE capacity numeric;
BEGIN
  SELECT "areaHa" INTO capacity FROM "Field"
    WHERE "organizationId" = NEW."organizationId" AND "farmId" = NEW."farmId" AND id = NEW."fieldId";
  IF planting_occupation_peak(NEW."organizationId", NEW."farmId", NEW."fieldId") > capacity THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'Planting_temporal_capacity_check',
      MESSAGE = 'Planting exceeds temporal field capacity';
  END IF;
  RETURN NEW;
END;
$$;
-- AFTER triggers run against the completed statement, without OLD/NEW overlays.
-- This also rejects multi-row inserts/updates atomically and avoids double count.
CREATE TRIGGER "Planting_temporal_capacity_check" AFTER INSERT OR UPDATE ON "Planting"
  FOR EACH ROW EXECUTE FUNCTION check_planting_temporal_capacity();

CREATE FUNCTION check_field_temporal_capacity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF planting_occupation_peak(NEW."organizationId", NEW."farmId", NEW.id) > NEW."areaHa" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'Field_temporal_capacity_check',
      MESSAGE = 'Field reduction invalidates historical planting occupation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Field_temporal_capacity_check" AFTER UPDATE OF "areaHa" ON "Field"
  FOR EACH ROW WHEN (NEW."areaHa" < OLD."areaHa") EXECUTE FUNCTION check_field_temporal_capacity();

-- Keep the migration safe even if a writer changed data since the read-only
-- preflight. DDL locks are held until COMMIT; fail instead of normalizing facts.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Field" f
    WHERE planting_occupation_peak(f."organizationId", f."farmId", f.id) > f."areaHa") THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Existing planting occupation exceeds field capacity';
  END IF;
END;
$$;

COMMIT;
