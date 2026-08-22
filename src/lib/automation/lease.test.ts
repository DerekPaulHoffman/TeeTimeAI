import { describe, expect, it, vi } from "vitest";

import {
  withPostgresAdvisoryLease,
  withPostgresAdvisoryTextLease,
} from "./lease";

describe("Postgres advisory leases", () => {
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

  it("keeps the default timeout while exposing an absolute worker deadline", async () => {
    const client = createLeaseClient(true);
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(1_000);

    try {
      await expect(
        withPostgresAdvisoryTextLease(
          client,
          "writer-lane",
          async (context) => context,
        ),
      ).resolves.toEqual({
        acquired: true,
        value: {
          deadlineAt: new Date(61_000),
          timeoutMs: 60_000,
        },
      });
    } finally {
      dateNow.mockRestore();
    }

    expect(client.transactionOptions).toEqual([{ timeout: 60_000 }]);
  });

  it("applies an explicit writer envelope to the transaction and deadline", async () => {
    const client = createLeaseClient(true);
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(10_000);

    try {
      await expect(
        withPostgresAdvisoryTextLease(
          client,
          "course-support-writer",
          async (context) => context,
          { timeout: 240_000 },
        ),
      ).resolves.toEqual({
        acquired: true,
        value: {
          deadlineAt: new Date(250_000),
          timeoutMs: 240_000,
        },
      });
    } finally {
      dateNow.mockRestore();
    }

    expect(client.transactionOptions).toEqual([{ timeout: 240_000 }]);
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
