BEGIN;

-- Required on fresh/shadow databases as well as the existing local database.
CREATE EXTENSION IF NOT EXISTS postgis;

-- CreateEnum
CREATE TYPE "FieldStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "CropScope" AS ENUM ('GLOBAL', 'ORGANIZATION');

-- CreateEnum
CREATE TYPE "CropStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "SeasonStatus" AS ENUM ('PLANNED', 'IN_PROGRESS', 'FINISHED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PlantingStatus" AS ENUM ('PLANNED', 'IN_PROGRESS', 'FINISHED', 'CANCELLED');

-- CreateTable
CREATE TABLE "Field" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "farmId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "areaHa" DECIMAL(18,6) NOT NULL,
    "soilType" TEXT,
    "description" TEXT,
    "notes" TEXT,
    "status" "FieldStatus" NOT NULL DEFAULT 'ACTIVE',
    "boundary" geometry(MultiPolygon,4326),
    "geometryRevision" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Field_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Crop" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "scope" "CropScope" NOT NULL,
    "organizationId" UUID,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "CropStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Crop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Season" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "farmId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "expectedEndDate" DATE NOT NULL,
    "actualEndDate" DATE,
    "status" "SeasonStatus" NOT NULL DEFAULT 'PLANNED',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Season_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Planting" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "farmId" UUID NOT NULL,
    "seasonId" UUID NOT NULL,
    "fieldId" UUID NOT NULL,
    "cropId" UUID NOT NULL,
    "variety" TEXT,
    "plannedAreaHa" DECIMAL(18,6) NOT NULL,
    "actualAreaHa" DECIMAL(18,6),
    "plannedStartDate" DATE NOT NULL,
    "expectedEndDate" DATE,
    "actualStartDate" DATE,
    "actualEndDate" DATE,
    "spacingMeters" DECIMAL(18,6),
    "populationPerHa" DECIMAL(20,6),
    "notes" TEXT,
    "status" "PlantingStatus" NOT NULL DEFAULT 'PLANNED',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Planting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Field_organizationId_farmId_status_idx" ON "Field"("organizationId", "farmId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Field_organizationId_farmId_id_key" ON "Field"("organizationId", "farmId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Field_organizationId_farmId_code_key" ON "Field"("organizationId", "farmId", "code");

-- CreateIndex
CREATE INDEX "Crop_scope_organizationId_status_idx" ON "Crop"("scope", "organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Crop_organizationId_code_key" ON "Crop"("organizationId", "code");

-- CreateIndex
CREATE INDEX "Season_organizationId_farmId_status_idx" ON "Season"("organizationId", "farmId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Season_organizationId_farmId_id_key" ON "Season"("organizationId", "farmId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Season_organizationId_farmId_code_key" ON "Season"("organizationId", "farmId", "code");

-- CreateIndex
CREATE INDEX "Planting_organizationId_farmId_fieldId_status_idx" ON "Planting"("organizationId", "farmId", "fieldId", "status");

-- CreateIndex
CREATE INDEX "Planting_organizationId_farmId_seasonId_status_idx" ON "Planting"("organizationId", "farmId", "seasonId", "status");

-- CreateIndex
CREATE INDEX "Planting_cropId_idx" ON "Planting"("cropId");

-- AddForeignKey
ALTER TABLE "Field" ADD CONSTRAINT "Field_organizationId_farmId_fkey" FOREIGN KEY ("organizationId", "farmId") REFERENCES "Farm"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Crop" ADD CONSTRAINT "Crop_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Season" ADD CONSTRAINT "Season_organizationId_farmId_fkey" FOREIGN KEY ("organizationId", "farmId") REFERENCES "Farm"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Planting" ADD CONSTRAINT "Planting_organizationId_farmId_fieldId_fkey" FOREIGN KEY ("organizationId", "farmId", "fieldId") REFERENCES "Field"("organizationId", "farmId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Planting" ADD CONSTRAINT "Planting_organizationId_farmId_seasonId_fkey" FOREIGN KEY ("organizationId", "farmId", "seasonId") REFERENCES "Season"("organizationId", "farmId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Planting" ADD CONSTRAINT "Planting_cropId_fkey" FOREIGN KEY ("cropId") REFERENCES "Crop"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- PostgreSQL/PostGIS features not represented by the Prisma schema.
CREATE INDEX "Field_boundary_gist_idx" ON "Field" USING GIST ("boundary");
CREATE UNIQUE INDEX "Crop_global_code_key" ON "Crop" ("code") WHERE "scope" = 'GLOBAL';

ALTER TABLE "Field" ADD CONSTRAINT "Field_area_check"
  CHECK ("areaHa" > 0 AND "areaHa" <> 'NaN'::numeric);
ALTER TABLE "Field" ADD CONSTRAINT "Field_code_check"
  CHECK ("code" <> '' AND "code" = upper(btrim("code")));
ALTER TABLE "Field" ADD CONSTRAINT "Field_geometry_revision_check" CHECK ("geometryRevision" >= 0);
ALTER TABLE "Field" ADD CONSTRAINT "Field_boundary_check"
  CHECK ("boundary" IS NULL OR (
    NOT ST_IsEmpty("boundary") AND ST_IsValid("boundary", 0)
    AND ST_XMin(Box3D("boundary")) >= -180 AND ST_XMax(Box3D("boundary")) <= 180
    AND ST_YMin(Box3D("boundary")) >= -90 AND ST_YMax(Box3D("boundary")) <= 90));
ALTER TABLE "Crop" ADD CONSTRAINT "Crop_scope_check"
  CHECK (("scope" = 'GLOBAL' AND "organizationId" IS NULL)
      OR ("scope" = 'ORGANIZATION' AND "organizationId" IS NOT NULL));
ALTER TABLE "Crop" ADD CONSTRAINT "Crop_code_check"
  CHECK ("code" <> '' AND "code" = upper(btrim("code")));
ALTER TABLE "Season" ADD CONSTRAINT "Season_code_check"
  CHECK ("code" <> '' AND "code" = upper(btrim("code")));
ALTER TABLE "Season" ADD CONSTRAINT "Season_dates_check"
  CHECK ("expectedEndDate" >= "startDate"
    AND ("actualEndDate" IS NULL OR "actualEndDate" >= "startDate"));
ALTER TABLE "Planting" ADD CONSTRAINT "Planting_areas_check"
  CHECK ("plannedAreaHa" > 0 AND "plannedAreaHa" <> 'NaN'::numeric
    AND ("actualAreaHa" IS NULL OR ("actualAreaHa" > 0 AND "actualAreaHa" <> 'NaN'::numeric)));
ALTER TABLE "Planting" ADD CONSTRAINT "Planting_quantities_check"
  CHECK (("spacingMeters" IS NULL OR ("spacingMeters" > 0 AND "spacingMeters" <> 'NaN'::numeric))
    AND ("populationPerHa" IS NULL OR ("populationPerHa" > 0 AND "populationPerHa" <> 'NaN'::numeric)));
ALTER TABLE "Planting" ADD CONSTRAINT "Planting_dates_check"
  CHECK (("expectedEndDate" IS NULL OR "expectedEndDate" >= "plannedStartDate")
    AND ("actualEndDate" IS NULL OR ("actualStartDate" IS NOT NULL AND "actualEndDate" >= "actualStartDate")));

-- Section 5.2: scope is immutable from creation, not just after the first use.
CREATE FUNCTION protect_crop_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."scope" IS DISTINCT FROM OLD."scope"
     OR NEW."organizationId" IS DISTINCT FROM OLD."organizationId" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Crop scope is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Crop_protect_scope" BEFORE UPDATE ON "Crop"
  FOR EACH ROW EXECUTE FUNCTION protect_crop_scope();

CREATE FUNCTION check_planting_crop_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Crop" c WHERE c."id" = NEW."cropId"
    AND (c."scope" = 'GLOBAL' OR c."organizationId" = NEW."organizationId")) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Incompatible planting crop scope';
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER "Planting_crop_scope_check"
  AFTER INSERT OR UPDATE ON "Planting" NOT DEFERRABLE
  FOR EACH ROW EXECUTE FUNCTION check_planting_crop_scope();

-- Individual capacity only. No aggregate/temporal occupancy enforcement here.
-- A no-op write serializes with Field edits AND changes its MVCC tuple version.
-- Thus Repeatable Read cannot approve against an obsolete snapshot after waiting.
CREATE FUNCTION check_planting_individual_area() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE capacity numeric;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW."organizationId", NEW."farmId", NEW."fieldId", NEW."plannedAreaHa", NEW."actualAreaHa")
       IS NOT DISTINCT FROM
       ROW(OLD."organizationId", OLD."farmId", OLD."fieldId", OLD."plannedAreaHa", OLD."actualAreaHa") THEN
      RETURN NEW;
    END IF;
  END IF;
  UPDATE "Field" SET "areaHa" = "areaHa"
    WHERE "organizationId" = NEW."organizationId" AND "farmId" = NEW."farmId" AND "id" = NEW."fieldId"
    RETURNING "areaHa" INTO capacity;
  IF FOUND AND (NEW."plannedAreaHa" > capacity OR NEW."actualAreaHa" > capacity) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Planting exceeds individual field capacity';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Planting_individual_area_check" BEFORE INSERT OR UPDATE ON "Planting"
  FOR EACH ROW EXECUTE FUNCTION check_planting_individual_area();

CREATE FUNCTION check_field_individual_capacity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Planting" p WHERE p."organizationId" = NEW."organizationId"
    AND p."farmId" = NEW."farmId" AND p."fieldId" = NEW."id"
    AND (p."plannedAreaHa" > NEW."areaHa" OR p."actualAreaHa" > NEW."areaHa")) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Field reduction invalidates planting area';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Field_individual_capacity_check" AFTER UPDATE OF "areaHa" ON "Field"
  FOR EACH ROW WHEN (NEW."areaHa" < OLD."areaHa") EXECUTE FUNCTION check_field_individual_capacity();

-- Revision of stored geometry bytes, not a history/snapshot table.
CREATE FUNCTION maintain_field_geometry_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."geometryRevision" := CASE WHEN NEW."boundary" IS NULL THEN 0 ELSE 1 END;
  ELSE
    NEW."geometryRevision" := OLD."geometryRevision";
    IF ST_AsEWKB(NEW."boundary") IS DISTINCT FROM ST_AsEWKB(OLD."boundary") THEN
      NEW."geometryRevision" := OLD."geometryRevision" + 1;
      NEW."updatedAt" := CURRENT_TIMESTAMP;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Field_geometry_revision" BEFORE INSERT OR UPDATE ON "Field"
  FOR EACH ROW EXECUTE FUNCTION maintain_field_geometry_revision();

COMMIT;
