type AdvisoryLeaseClient = {
  $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T>;
  $transaction<T>(worker: (tx: AdvisoryLeaseTransaction) => Promise<T>): Promise<T>;
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

export async function withPostgresAdvisoryLease<T>(
  client: AdvisoryLeaseClient,
  lockKey: bigint,
  worker: () => Promise<T>
): Promise<AdvisoryLeaseResult<T>> {
  return client.$transaction(async (tx) => {
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
  });
}
