type AdvisoryLeaseClient = {
  $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T>;
  $transaction<T>(
    worker: (tx: AdvisoryLeaseTransaction) => Promise<T>,
    options?: { timeout?: number }
  ): Promise<T>;
};

type AdvisoryLeaseTransaction = {
  $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T>;
};

type AdvisoryLeaseResult<T> =
  | {
      acquired: true;
      value: T;
    }
  | {
      acquired: false;
    };

const AUTOMATION_LEASE_TRANSACTION_TIMEOUT_MS = 60_000;

export async function withPostgresAdvisoryLease<T>(
  client: AdvisoryLeaseClient,
  lockKey: bigint,
  worker: () => Promise<T>
): Promise<AdvisoryLeaseResult<T>> {
  return client.$transaction(
    async (tx) => {
      const [lockResult] = await tx.$queryRawUnsafe<Array<{ locked: boolean }>>(
        "SELECT pg_try_advisory_xact_lock($1::bigint) AS locked",
        lockKey
      );

      if (!lockResult?.locked) {
        return { acquired: false };
      }

      return {
        acquired: true,
        value: await worker()
      };
    },
    { timeout: AUTOMATION_LEASE_TRANSACTION_TIMEOUT_MS }
  );
}

export async function withPostgresAdvisoryTextLease<T>(
  client: AdvisoryLeaseClient,
  lockKey: string,
  worker: () => Promise<T>
): Promise<AdvisoryLeaseResult<T>> {
  return client.$transaction(
    async (tx) => {
      const [lockResult] = await tx.$queryRawUnsafe<Array<{ locked: boolean }>>(
        "SELECT pg_try_advisory_xact_lock(hashtextextended($1::text, 0)) AS locked",
        lockKey
      );

      if (!lockResult?.locked) {
        return { acquired: false };
      }

      return {
        acquired: true,
        value: await worker()
      };
    },
    { timeout: AUTOMATION_LEASE_TRANSACTION_TIMEOUT_MS }
  );
}
