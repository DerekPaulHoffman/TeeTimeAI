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

export type PostgresAdvisoryLeaseContext = {
  deadlineAt: Date;
  timeoutMs: number;
};

type PostgresAdvisoryLeaseOptions = {
  timeout?: number;
};

function getAdvisoryLeaseTimeout(options?: PostgresAdvisoryLeaseOptions) {
  const timeout =
    options?.timeout ?? AUTOMATION_LEASE_TRANSACTION_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1) {
    throw new Error("The advisory lease timeout must be a positive integer.");
  }
  return timeout;
}

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
  worker: (context: PostgresAdvisoryLeaseContext) => Promise<T>,
  options?: PostgresAdvisoryLeaseOptions,
): Promise<AdvisoryLeaseResult<T>> {
  const timeout = getAdvisoryLeaseTimeout(options);
  // Start the deadline before Prisma opens the transaction. Any pool wait or
  // lock acquisition therefore consumes the caller's budget conservatively.
  const deadlineAt = new Date(Date.now() + timeout);
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
        value: await worker({ deadlineAt, timeoutMs: timeout }),
      };
    },
    { timeout },
  );
}
