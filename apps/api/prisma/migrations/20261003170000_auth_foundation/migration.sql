BEGIN;

CREATE TABLE "PasswordCredential" (
  "userId" UUID PRIMARY KEY,
  "passwordHash" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PasswordCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "PasswordCredential_hash_check" CHECK ("passwordHash" LIKE '$argon2id$%')
);

CREATE TABLE "AuthSession" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "revokedAt" TIMESTAMPTZ(3),
  CONSTRAINT "AuthSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "AuthSession_dates_check" CHECK ("expiresAt" > "createdAt" AND ("revokedAt" IS NULL OR "revokedAt" >= "createdAt"))
);
CREATE INDEX "AuthSession_userId_expiresAt_idx" ON "AuthSession"("userId", "expiresAt");

CREATE TABLE "RefreshToken" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "sessionId" UUID NOT NULL,
  "tokenDigest" CHAR(64) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "consumedAt" TIMESTAMPTZ(3),
  CONSTRAINT "RefreshToken_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AuthSession"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "RefreshToken_digest_check" CHECK ("tokenDigest" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "RefreshToken_dates_check" CHECK ("expiresAt" > "createdAt" AND ("consumedAt" IS NULL OR "consumedAt" >= "createdAt"))
);
CREATE UNIQUE INDEX "RefreshToken_tokenDigest_key" ON "RefreshToken"("tokenDigest");
CREATE INDEX "RefreshToken_sessionId_idx" ON "RefreshToken"("sessionId");

CREATE TABLE "AuthRateLimit" (
  "key" CHAR(64) PRIMARY KEY,
  "windowStartedAt" TIMESTAMPTZ(3) NOT NULL,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "attempts" INTEGER NOT NULL,
  CONSTRAINT "AuthRateLimit_values_check" CHECK ("key" ~ '^[a-f0-9]{64}$' AND "attempts" > 0 AND "expiresAt" > "windowStartedAt")
);
CREATE INDEX "AuthRateLimit_expiresAt_idx" ON "AuthRateLimit"("expiresAt");

COMMIT;
