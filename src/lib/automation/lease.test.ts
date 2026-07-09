import { describe, expect, it } from "vitest";

import { withPostgresAdvisoryLease } from "./lease";

describe("withPostgresAdvisoryLease", () => {
  it("skips the worker when the lease is already held", async () => {
    const client = createLeaseClient(false);
    let calls = 0;

    const result = await withPostgresAdvisoryLease(client, 123n, async () => {
      calls += 1;
      return "worked";
    });

    expect(result).toEqual({ acquired: false });
    expect(calls).toBe(0);
    expect(client.transactionCalls).toBe(1);
    expect(client.calls).toEqual([
      { sql: "SELECT pg_try_advisory_xact_lock($1::bigint) AS locked", values: [123n] }
    ]);
  });

  it("runs the worker and releases the lease when acquired", async () => {
    const client = createLeaseClient(true);

    const result = await withPostgresAdvisoryLease(client, 456n, async () => "worked");

    expect(result).toEqual({ acquired: true, value: "worked" });
    expect(client.transactionCalls).toBe(1);
    expect(client.transactionOptions).toEqual([{ timeout: 60_000 }]);
    expect(client.calls).toEqual([
      { sql: "SELECT pg_try_advisory_xact_lock($1::bigint) AS locked", values: [456n] }
    ]);
  });

  it("lets the transaction release the lease when the worker throws", async () => {
    const client = createLeaseClient(true);

    await expect(
      withPostgresAdvisoryLease(client, 789n, async () => {
        throw new Error("worker failed");
      })
    ).rejects.toThrow("worker failed");

    expect(client.transactionCalls).toBe(1);
    expect(client.calls).toEqual([
      { sql: "SELECT pg_try_advisory_xact_lock($1::bigint) AS locked", values: [789n] }
    ]);
  });
});

function createLeaseClient(locked: boolean) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const transactionOptions: Array<{ timeout?: number } | undefined> = [];
  let transactionCalls = 0;

  return {
    calls,
    transactionOptions,
    get transactionCalls() {
      return transactionCalls;
    },
    async $transaction<T>(
      worker: (tx: { $queryRawUnsafe: typeof this.$queryRawUnsafe }) => Promise<T>,
      options?: { timeout?: number }
    ) {
      transactionCalls += 1;
      transactionOptions.push(options);
      return worker(this);
    },
    async $queryRawUnsafe(sql: string, ...values: unknown[]) {
      calls.push({ sql, values });

      if (sql.includes("pg_try_advisory")) {
        return [{ locked }];
      }

      return [{ unlocked: true }];
    }
  };
}
