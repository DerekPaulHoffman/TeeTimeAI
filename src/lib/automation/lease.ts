type AdvisoryLeaseClient = {
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
  const [lockResult] = await client.$queryRawUnsafe<Array<{ locked: boolean }>>(
    "SELECT pg_try_advisory_lock($1::bigint) AS locked",
    lockKey
  );

  if (!lockResult?.locked) {
    return { acquired: false };
  }

  try {
    return {
      acquired: true,
      value: await worker()
    };
  } finally {
    await client.$queryRawUnsafe(
      "SELECT pg_advisory_unlock($1::bigint) AS unlocked",
      lockKey
    );
  }
}
