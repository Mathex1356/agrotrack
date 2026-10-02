BEGIN;

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'BLOCKED');

-- CreateEnum
CREATE TYPE "OrganizationStatus" AS ENUM ('PROVISIONING', 'ACTIVE', 'SUSPENDED', 'CLOSED');

-- CreateEnum
CREATE TYPE "SystemRoleCode" AS ENUM ('OWNER', 'MANAGER', 'AGRONOMIST', 'WORKER');

-- CreateEnum
CREATE TYPE "RoleStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "PermissionStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "PermissionScope" AS ENUM ('ORGANIZATION', 'FARM');

-- CreateEnum
CREATE TYPE "OrganizationMembershipStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'REVOKED');

-- CreateEnum
CREATE TYPE "FarmStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "FarmMembershipStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "displayName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "normalizedEmail" TEXT NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Organization" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "referenceCode" TEXT NOT NULL,
    "status" "OrganizationStatus" NOT NULL DEFAULT 'PROVISIONING',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Role" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "systemCode" "SystemRoleCode",
    "status" "RoleStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Permission" (
    "code" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "scope" "PermissionScope" NOT NULL,
    "status" "PermissionStatus" NOT NULL DEFAULT 'ACTIVE',

    CONSTRAINT "Permission_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "RolePermission" (
    "organizationId" UUID NOT NULL,
    "roleId" UUID NOT NULL,
    "permissionCode" TEXT NOT NULL,

    CONSTRAINT "RolePermission_pkey" PRIMARY KEY ("roleId","permissionCode")
);

-- CreateTable
CREATE TABLE "OrganizationMembership" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "roleId" UUID NOT NULL,
    "status" "OrganizationMembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "joinedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrganizationMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Farm" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "legalOwnerName" TEXT,
    "locationText" TEXT,
    "municipality" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "totalAreaHa" DECIMAL(18,6) NOT NULL,
    "productiveAreaHa" DECIMAL(18,6) NOT NULL,
    "description" TEXT,
    "status" "FarmStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Farm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FarmMembership" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "organizationMembershipId" UUID NOT NULL,
    "farmId" UUID NOT NULL,
    "status" "FarmMembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "revokedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FarmMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invitation" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "normalizedEmail" TEXT NOT NULL,
    "roleId" UUID NOT NULL,
    "inviterMembershipId" UUID,
    "tokenDigest" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "acceptedAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),
    "acceptedMembershipId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvitationFarm" (
    "organizationId" UUID NOT NULL,
    "invitationId" UUID NOT NULL,
    "farmId" UUID NOT NULL,

    CONSTRAINT "InvitationFarm_pkey" PRIMARY KEY ("invitationId","farmId")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_normalizedEmail_key" ON "User"("normalizedEmail");

-- CreateIndex
CREATE UNIQUE INDEX "Organization_referenceCode_key" ON "Organization"("referenceCode");

-- CreateIndex
CREATE UNIQUE INDEX "Role_organizationId_id_key" ON "Role"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Role_organizationId_systemCode_key" ON "Role"("organizationId", "systemCode");

-- CreateIndex
CREATE UNIQUE INDEX "Role_organizationId_name_key" ON "Role"("organizationId", "name");

-- CreateIndex
CREATE INDEX "RolePermission_organizationId_roleId_idx" ON "RolePermission"("organizationId", "roleId");

-- CreateIndex
CREATE INDEX "RolePermission_permissionCode_idx" ON "RolePermission"("permissionCode");

-- CreateIndex
CREATE INDEX "OrganizationMembership_userId_idx" ON "OrganizationMembership"("userId");

-- CreateIndex
CREATE INDEX "OrganizationMembership_organizationId_roleId_status_idx" ON "OrganizationMembership"("organizationId", "roleId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationMembership_organizationId_id_key" ON "OrganizationMembership"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationMembership_organizationId_userId_key" ON "OrganizationMembership"("organizationId", "userId");

-- CreateIndex
CREATE INDEX "Farm_organizationId_status_idx" ON "Farm"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Farm_organizationId_id_key" ON "Farm"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Farm_organizationId_code_key" ON "Farm"("organizationId", "code");

-- CreateIndex
CREATE INDEX "FarmMembership_organizationId_farmId_status_idx" ON "FarmMembership"("organizationId", "farmId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "FarmMembership_member_farm_key" ON "FarmMembership"("organizationId", "organizationMembershipId", "farmId");

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_tokenDigest_key" ON "Invitation"("tokenDigest");

-- CreateIndex
CREATE INDEX "Invitation_organizationId_normalizedEmail_idx" ON "Invitation"("organizationId", "normalizedEmail");

-- CreateIndex
CREATE INDEX "Invitation_organizationId_roleId_idx" ON "Invitation"("organizationId", "roleId");

-- CreateIndex
CREATE INDEX "Invitation_organizationId_inviterMembershipId_idx" ON "Invitation"("organizationId", "inviterMembershipId");

-- CreateIndex
CREATE INDEX "Invitation_organizationId_acceptedMembershipId_idx" ON "Invitation"("organizationId", "acceptedMembershipId");

-- CreateIndex
CREATE INDEX "Invitation_expiresAt_idx" ON "Invitation"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_organizationId_id_key" ON "Invitation"("organizationId", "id");

-- CreateIndex
CREATE INDEX "InvitationFarm_organizationId_invitationId_idx" ON "InvitationFarm"("organizationId", "invitationId");

-- CreateIndex
CREATE INDEX "InvitationFarm_organizationId_farmId_idx" ON "InvitationFarm"("organizationId", "farmId");

-- AddForeignKey
ALTER TABLE "Role" ADD CONSTRAINT "Role_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_organizationId_roleId_fkey" FOREIGN KEY ("organizationId", "roleId") REFERENCES "Role"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_permissionCode_fkey" FOREIGN KEY ("permissionCode") REFERENCES "Permission"("code") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OrganizationMembership" ADD CONSTRAINT "OrganizationMembership_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OrganizationMembership" ADD CONSTRAINT "OrganizationMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OrganizationMembership" ADD CONSTRAINT "OrganizationMembership_organizationId_roleId_fkey" FOREIGN KEY ("organizationId", "roleId") REFERENCES "Role"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Farm" ADD CONSTRAINT "Farm_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FarmMembership" ADD CONSTRAINT "FarmMembership_organizationId_organizationMembershipId_fkey" FOREIGN KEY ("organizationId", "organizationMembershipId") REFERENCES "OrganizationMembership"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FarmMembership" ADD CONSTRAINT "FarmMembership_organizationId_farmId_fkey" FOREIGN KEY ("organizationId", "farmId") REFERENCES "Farm"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_organizationId_roleId_fkey" FOREIGN KEY ("organizationId", "roleId") REFERENCES "Role"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_organizationId_inviterMembershipId_fkey" FOREIGN KEY ("organizationId", "inviterMembershipId") REFERENCES "OrganizationMembership"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_organizationId_acceptedMembershipId_fkey" FOREIGN KEY ("organizationId", "acceptedMembershipId") REFERENCES "OrganizationMembership"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InvitationFarm" ADD CONSTRAINT "InvitationFarm_organizationId_invitationId_fkey" FOREIGN KEY ("organizationId", "invitationId") REFERENCES "Invitation"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InvitationFarm" ADD CONSTRAINT "InvitationFarm_organizationId_farmId_fkey" FOREIGN KEY ("organizationId", "farmId") REFERENCES "Farm"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Checks not expressible in the Prisma schema. Preserve in future migrations.
ALTER TABLE "User" ADD CONSTRAINT "User_normalized_email_check"
  CHECK ("normalizedEmail" <> '' AND "normalizedEmail" = lower(btrim("email")));
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_reference_code_check"
  CHECK ("referenceCode" <> '' AND "referenceCode" = upper(btrim("referenceCode")));
ALTER TABLE "Farm" ADD CONSTRAINT "Farm_code_check"
  CHECK ("code" <> '' AND "code" = upper(btrim("code")));
ALTER TABLE "Farm" ADD CONSTRAINT "Farm_areas_check"
  CHECK ("totalAreaHa" <> 'NaN'::numeric AND "productiveAreaHa" <> 'NaN'::numeric
    AND "totalAreaHa" > 0 AND "productiveAreaHa" >= 0
    AND "productiveAreaHa" <= "totalAreaHa");
ALTER TABLE "Role" ADD CONSTRAINT "Role_system_active_check"
  CHECK ("systemCode" IS NULL OR "status" = 'ACTIVE');
ALTER TABLE "OrganizationMembership" ADD CONSTRAINT "OrganizationMembership_revocation_check"
  CHECK (("status" = 'REVOKED') = ("revokedAt" IS NOT NULL)
    AND ("revokedAt" IS NULL OR "revokedAt" >= "joinedAt"));
ALTER TABLE "FarmMembership" ADD CONSTRAINT "FarmMembership_revocation_check"
  CHECK (("status" = 'REVOKED') = ("revokedAt" IS NOT NULL)
    AND ("revokedAt" IS NULL OR "revokedAt" >= "createdAt"));
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_normalized_email_check"
  CHECK ("normalizedEmail" <> '' AND "normalizedEmail" = lower(btrim("normalizedEmail")));
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_digest_check"
  CHECK (btrim("tokenDigest") <> '');
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_lifecycle_check"
  CHECK ("expiresAt" > "createdAt"
    AND (("acceptedAt" IS NOT NULL) = ("acceptedMembershipId" IS NOT NULL))
    AND NOT ("acceptedAt" IS NOT NULL AND "revokedAt" IS NOT NULL)
    AND ("acceptedAt" IS NULL OR ("acceptedAt" >= "createdAt" AND "acceptedAt" < "expiresAt"))
    AND ("revokedAt" IS NULL OR "revokedAt" >= "createdAt"));

-- Stable identity of reserved roles. No authorization or last-owner enforcement.
CREATE FUNCTION protect_system_role() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."systemCode" IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Protected system role';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW."systemCode" IS DISTINCT FROM OLD."systemCode"
     OR (OLD."systemCode" IS NOT NULL AND
       (NEW."id" IS DISTINCT FROM OLD."id" OR NEW."organizationId" IS DISTINCT FROM OLD."organizationId")) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Protected system role identity';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Role_protect_system_identity"
  BEFORE UPDATE OR DELETE ON "Role" FOR EACH ROW EXECUTE FUNCTION protect_system_role();

COMMIT;
