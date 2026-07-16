import { randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

import { normalizeProviderFamilyKey } from "./provider-capabilities";

const GLOBAL_PROVIDER_REQUEST_KEY = "__GLOBAL_PROVIDER_REQUEST__";
const PROVIDER_FAMILY_MUTEX_SLOT = -1;
const PROVIDER_REQUEST_SLOTS = 2;
const PROVIDER_REQUEST_LEASE_MS = 2 * 60 * 1000;
const PROVIDER_REQUEST_HEARTBEAT_MS = 30 * 1000;
const PROVIDER_REQUEST_CLAIM_ATTEMPTS = 8;
const PROVIDER_REQUEST_RETRY_MS = 500;

type ProviderRequestLease = {
  providerFamilyKey: string;
  globalSlot: number;
  leaseToken: string;
};

type ProviderRequestLeaseDependencies = {
  claim: (providerFamilyKey: string) => Promise<ProviderRequestLease | null>;
  renew: (lease: ProviderRequestLease) => Promise<boolean>;
  release: (lease: ProviderRequestLease) => Promise<void>;
  wait: (milliseconds: number) => Promise<void>;
};

const defaultDependencies: ProviderRequestLeaseDependencies = {
  claim: claimProviderRequestLease,
  renew: renewProviderRequestLease,
  release: releaseProviderRequestLease,
  wait: (milliseconds) =>
    new Promise((resolve) => {
      setTimeout(resolve, milliseconds);
    })
};

export async function runWithProviderRequestLease<T>(
  providerFamilyKey: string,
  worker: () => Promise<T>,
  dependencies: ProviderRequestLeaseDependencies = defaultDependencies
) {
  const normalizedFamily = normalizeProviderFamilyKey(providerFamilyKey);
  for (let attempt = 0; attempt < PROVIDER_REQUEST_CLAIM_ATTEMPTS; attempt += 1) {
    const lease = await dependencies.claim(normalizedFamily);
    if (lease) {
      const heartbeatController = new AbortController();
      let heartbeatError: unknown = null;
      const heartbeat = maintainProviderRequestLease(
        lease,
        dependencies.renew,
        heartbeatController.signal
      ).catch((error) => {
        heartbeatError = error;
      });
      try {
        const value = await worker();
        heartbeatController.abort();
        await heartbeat;
        if (heartbeatError) {
          throw heartbeatError;
        }
        return { acquired: true as const, value };
      } finally {
        heartbeatController.abort();
        await heartbeat;
        await dependencies.release(lease);
      }
    }
    if (attempt < PROVIDER_REQUEST_CLAIM_ATTEMPTS - 1) {
      await dependencies.wait(PROVIDER_REQUEST_RETRY_MS);
    }
  }
  return { acquired: false as const };
}

async function maintainProviderRequestLease(
  lease: ProviderRequestLease,
  renew: ProviderRequestLeaseDependencies["renew"],
  signal: AbortSignal
) {
  while (await waitForProviderRequestHeartbeat(signal)) {
    if (!(await renew(lease))) {
      throw new Error("Provider request lease expired while provider work was still running");
    }
  }
}

function waitForProviderRequestHeartbeat(signal: AbortSignal) {
  if (signal.aborted) {
    return Promise.resolve(false);
  }

  return new Promise<boolean>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, PROVIDER_REQUEST_HEARTBEAT_MS);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function claimProviderRequestLease(providerFamilyKey: string) {
  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + PROVIDER_REQUEST_LEASE_MS);
  const leaseToken = randomUUID();

  return prisma.$transaction(async (transaction) => {
    const familyRows = await transaction.$queryRaw<Array<{ leaseToken: string }>>(
      Prisma.sql`
        INSERT INTO "ProviderRequestLease" (
          "providerFamilyKey", "slot", "leaseToken", "leaseExpiresAt", "updatedAt"
        )
        VALUES (
          ${providerFamilyKey}, ${PROVIDER_FAMILY_MUTEX_SLOT}, ${leaseToken}, ${leaseExpiresAt}, ${now}
        )
        ON CONFLICT ("providerFamilyKey", "slot") DO UPDATE
        SET
          "leaseToken" = EXCLUDED."leaseToken",
          "leaseExpiresAt" = EXCLUDED."leaseExpiresAt",
          "updatedAt" = EXCLUDED."updatedAt"
        WHERE "ProviderRequestLease"."leaseExpiresAt" <= ${now}
        RETURNING "leaseToken"
      `
    );
    if (!familyRows[0]) {
      return null;
    }

    for (let globalSlot = 0; globalSlot < PROVIDER_REQUEST_SLOTS; globalSlot += 1) {
      const globalRows = await transaction.$queryRaw<Array<{ slot: number }>>(
        Prisma.sql`
          INSERT INTO "ProviderRequestLease" (
            "providerFamilyKey", "slot", "leaseToken", "leaseExpiresAt", "updatedAt"
          )
          VALUES (
            ${GLOBAL_PROVIDER_REQUEST_KEY}, ${globalSlot}, ${leaseToken}, ${leaseExpiresAt}, ${now}
          )
          ON CONFLICT ("providerFamilyKey", "slot") DO UPDATE
          SET
            "leaseToken" = EXCLUDED."leaseToken",
            "leaseExpiresAt" = EXCLUDED."leaseExpiresAt",
            "updatedAt" = EXCLUDED."updatedAt"
          WHERE "ProviderRequestLease"."leaseExpiresAt" <= ${now}
          RETURNING "slot"
        `
      );
      if (globalRows[0]) {
        return {
          providerFamilyKey,
          globalSlot: globalRows[0].slot,
          leaseToken
        };
      }
    }

    await transaction.providerRequestLease.deleteMany({
      where: {
        providerFamilyKey,
        slot: PROVIDER_FAMILY_MUTEX_SLOT,
        leaseToken
      }
    });
    return null;
  });
}

async function renewProviderRequestLease(lease: ProviderRequestLease) {
  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + PROVIDER_REQUEST_LEASE_MS);

  try {
    return await prisma.$transaction(async (transaction) => {
      const family = await transaction.providerRequestLease.updateMany({
        where: {
          providerFamilyKey: lease.providerFamilyKey,
          slot: PROVIDER_FAMILY_MUTEX_SLOT,
          leaseToken: lease.leaseToken,
          leaseExpiresAt: { gt: now }
        },
        data: { leaseExpiresAt, updatedAt: now }
      });
      const global = await transaction.providerRequestLease.updateMany({
        where: {
          providerFamilyKey: GLOBAL_PROVIDER_REQUEST_KEY,
          slot: lease.globalSlot,
          leaseToken: lease.leaseToken,
          leaseExpiresAt: { gt: now }
        },
        data: { leaseExpiresAt, updatedAt: now }
      });
      if (family.count !== 1 || global.count !== 1) {
        throw new ProviderRequestLeaseLostError();
      }
      return true;
    });
  } catch (error) {
    if (error instanceof ProviderRequestLeaseLostError) {
      return false;
    }
    throw error;
  }
}

class ProviderRequestLeaseLostError extends Error {}

async function releaseProviderRequestLease(lease: ProviderRequestLease) {
  await prisma.$transaction([
    prisma.providerRequestLease.deleteMany({
      where: {
        providerFamilyKey: lease.providerFamilyKey,
        slot: PROVIDER_FAMILY_MUTEX_SLOT,
        leaseToken: lease.leaseToken
      }
    }),
    prisma.providerRequestLease.deleteMany({
      where: {
        providerFamilyKey: GLOBAL_PROVIDER_REQUEST_KEY,
        slot: lease.globalSlot,
        leaseToken: lease.leaseToken
      }
    })
  ]);
}
