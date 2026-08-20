import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "@lpr/db";
import type { CycleObservation, HeartbeatRecorder, HeartbeatReport } from "./heartbeat.js";
import { ReconciliationRunner } from "./sweep-runner.js";
import { EMPTY_SWEEP, type SweepLogger, type SweepOutcome, type Sweeper } from "./sweeper.js";

/**
 * The loop itself (ADR-005).
 *
 * These are the properties that decide whether the scheduling guarantee is real
 * in production, and every one of them is a way the loop could stop without
 * anybody noticing: it never starts, it piles up, one sweeper's exception ends
 * it, or a failing cycle writes a healthy-looking heartbeat.
 *
 * Fake timers throughout — the loop's period is sixty seconds, and a test that
 * waited would be a test nobody runs.
 */

/** A pool whose only job is to grant the advisory lock the runner takes. */
function lockGrantingPool(options: { granted?: boolean } = {}): Pool {
  const granted = options.granted ?? true;
  return {
    connect: () =>
      Promise.resolve({
        query: (text: string) =>
          Promise.resolve({
            rows: text.includes("pg_try_advisory_lock") ? [{ locked: granted }] : [{}],
          }),
        release: () => undefined,
      }),
  } as unknown as Pool;
}

function collectingLogger(): SweepLogger & { warns: string[]; errors: string[] } {
  return {
    warns: [] as string[],
    errors: [] as string[],
    info: () => undefined,
    warn(message: string) {
      this.warns.push(message);
    },
    error(message: string) {
      this.errors.push(message);
    },
  };
}

function fakeHeartbeat(overrides: Partial<HeartbeatRecorder> = {}) {
  const observations: CycleObservation[] = [];
  const recorder: HeartbeatRecorder = {
    name: "sweep.heartbeat",
    record: (observation) => {
      observations.push(observation);
      return Promise.resolve({
        sweptAt: new Date(),
        consecutiveFailures: observation.failures.length === 0 ? 0 : 1,
        previous: null,
      } satisfies HeartbeatReport);
    },
    ...overrides,
  };
  return { recorder, observations };
}

function countingSweeper(name: string, outcome: SweepOutcome = EMPTY_SWEEP) {
  const calls = { count: 0 };
  const sweeper: Sweeper = {
    name,
    run: () => {
      calls.count += 1;
      return Promise.resolve(outcome);
    },
  };
  return { sweeper, calls };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ReconciliationRunner", () => {
  /**
   * After a restart the whole point is to converge NOW. Waiting out an interval
   * first would mean a worker returning from a six-hour outage leaves the
   * schedule wrong for another minute for no reason.
   */
  it("sweeps immediately on start rather than waiting out the first interval", async () => {
    const { sweeper, calls } = countingSweeper("sweep.activate_due");
    const { recorder } = fakeHeartbeat();
    const runner = new ReconciliationRunner({
      pool: lockGrantingPool(),
      sweepers: [sweeper],
      heartbeat: recorder,
      intervalMs: 60_000,
      logger: collectingLogger(),
    });

    runner.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(calls.count).toBe(1);
    await runner.stop();
  });

  it("keeps sweeping on the interval", async () => {
    const { sweeper, calls } = countingSweeper("sweep.activate_due");
    const { recorder } = fakeHeartbeat();
    const runner = new ReconciliationRunner({
      pool: lockGrantingPool(),
      sweepers: [sweeper],
      heartbeat: recorder,
      intervalMs: 60_000,
      logger: collectingLogger(),
    });

    runner.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(calls.count).toBe(3);
    await runner.stop();
  });

  /**
   * With `setInterval`, a cycle that outlives its period queues the next
   * callback, and the worker's first bad minute becomes an unbounded pile-up on
   * the database that never recovers. The next cycle is scheduled only once the
   * previous one has finished.
   */
  it("never overlaps cycles, even when one outlasts the interval", async () => {
    let running = 0;
    let maxConcurrent = 0;
    const slow: Sweeper = {
      name: "sweep.slow",
      run: async () => {
        running += 1;
        maxConcurrent = Math.max(maxConcurrent, running);
        await new Promise((resolve) => setTimeout(resolve, 150_000));
        running -= 1;
        return EMPTY_SWEEP;
      },
    };
    const { recorder } = fakeHeartbeat();
    const logger = collectingLogger();
    const runner = new ReconciliationRunner({
      pool: lockGrantingPool(),
      sweepers: [slow],
      heartbeat: recorder,
      intervalMs: 60_000,
      logger,
    });

    runner.start();
    await vi.advanceTimersByTimeAsync(500_000);

    expect(maxConcurrent).toBe(1);
    // And it says so: an interval the cycle can no longer fit inside has
    // stretched the recovery window ADR-005 bounds.
    expect(logger.warns.some((warning) => warning.includes("longer than the"))).toBe(true);

    // The advance above lands mid-cycle, and `stop()` waits for it. With fake
    // timers nothing moves unless the test moves it, so the clock has to keep
    // running while the stop is pending.
    const stopping = runner.stop();
    await vi.advanceTimersByTimeAsync(200_000);
    await stopping;
  });

  /**
   * A participant not being reminded is bad. Their questionnaire never opening
   * is worse. One sweeper's exception must not reach the others.
   */
  it("isolates a throwing sweeper from the rest of the cycle", async () => {
    const exploding: Sweeper = {
      name: "sweep.notifications_due",
      run: () => Promise.reject(new Error("malformed reminder policy")),
    };
    const { sweeper: activate, calls: activateCalls } = countingSweeper("sweep.activate_due");
    const { sweeper: expire, calls: expireCalls } = countingSweeper("sweep.expire_due");
    const { recorder, observations } = fakeHeartbeat();
    const errors: Error[] = [];

    const runner = new ReconciliationRunner({
      pool: lockGrantingPool(),
      sweepers: [exploding, activate, expire],
      heartbeat: recorder,
      intervalMs: 60_000,
      logger: collectingLogger(),
      onError: (error) => errors.push(error),
    });

    runner.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(activateCalls.count).toBe(1);
    expect(expireCalls.count).toBe(1);
    expect(errors).toHaveLength(1);
    expect(observations[0]?.failures).toEqual([
      "sweep.notifications_due: malformed reminder policy",
    ]);

    // And the loop survives it.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(activateCalls.count).toBe(2);
    await runner.stop();
  });

  /**
   * Skipping the write on a bad cycle would surface as "the loop stopped",
   * pointing an operator at the wrong problem entirely.
   */
  it("writes a heartbeat even when every sweeper failed", async () => {
    const exploding: Sweeper = {
      name: "sweep.activate_due",
      run: () => Promise.reject(new Error("deadlock detected")),
    };
    const { recorder, observations } = fakeHeartbeat();
    const logger = collectingLogger();

    const runner = new ReconciliationRunner({
      pool: lockGrantingPool(),
      sweepers: [exploding],
      heartbeat: recorder,
      intervalMs: 60_000,
      logger,
    });

    runner.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(observations).toHaveLength(1);
    expect(observations[0]?.failures).toHaveLength(1);
    expect(logger.warns.some((warning) => warning.includes("consecutive failing cycles"))).toBe(
      true,
    );
    await runner.stop();
  });

  it("counts failed rows as an unclean cycle even when the sweeper did not throw", async () => {
    const { sweeper } = countingSweeper("sweep.expire_due", {
      claimed: 5,
      acted: 4,
      skipped: {},
      failed: 1,
    });
    const { recorder, observations } = fakeHeartbeat();
    const runner = new ReconciliationRunner({
      pool: lockGrantingPool(),
      sweepers: [sweeper],
      heartbeat: recorder,
      intervalMs: 60_000,
      logger: collectingLogger(),
    });

    runner.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(observations[0]?.failures).toEqual(["sweep.expire_due: 1 row(s) failed"]);
    await runner.stop();
  });

  it("survives a heartbeat that cannot be written", async () => {
    const { sweeper, calls } = countingSweeper("sweep.activate_due");
    const { recorder } = fakeHeartbeat({
      record: () => Promise.reject(new Error("relation does not exist")),
    });
    const errors: Error[] = [];
    const runner = new ReconciliationRunner({
      pool: lockGrantingPool(),
      sweepers: [sweeper],
      heartbeat: recorder,
      intervalMs: 60_000,
      logger: collectingLogger(),
      onError: (error) => errors.push(error),
    });

    runner.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000);

    // Losing the heartbeat costs observability. Losing the loop costs the
    // guarantee, so the loop keeps going.
    expect(calls.count).toBe(2);
    expect(errors.map((error) => error.message)).toContain("relation does not exist");
    await runner.stop();
  });

  /**
   * Expected whenever more than one replica runs, and explicitly not a failure:
   * another instance is doing this work right now.
   */
  it("skips a sweeper another replica already holds without calling it or failing", async () => {
    const { sweeper, calls } = countingSweeper("sweep.activate_due");
    const { recorder, observations } = fakeHeartbeat();
    const runner = new ReconciliationRunner({
      pool: lockGrantingPool({ granted: false }),
      sweepers: [sweeper],
      heartbeat: recorder,
      intervalMs: 60_000,
      logger: collectingLogger(),
    });

    runner.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(calls.count).toBe(0);
    expect(observations[0]?.failures).toEqual([]);

    const report = await runner.runCycle();
    expect(report.skipped).toEqual(["sweep.activate_due"]);
    await runner.stop();
  });

  /**
   * The startup message only proves the runner was constructed. Without this,
   * a worker whose very first sweep failed would log nothing further and look
   * exactly like a healthy one.
   */
  it("confirms the first completed cycle, once, and then stays quiet", async () => {
    const infos: string[] = [];
    const logger = { ...collectingLogger(), info: (message: string) => infos.push(message) };
    const { recorder } = fakeHeartbeat();
    const runner = new ReconciliationRunner({
      pool: lockGrantingPool(),
      sweepers: [],
      heartbeat: recorder,
      intervalMs: 60_000,
      logger,
    });

    runner.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(infos.filter((line) => line.includes("first reconciliation cycle"))).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(180_000);
    expect(infos.filter((line) => line.includes("first reconciliation cycle"))).toHaveLength(1);

    await runner.stop();
  });

  it("stops sweeping after stop()", async () => {
    const { sweeper, calls } = countingSweeper("sweep.activate_due");
    const { recorder } = fakeHeartbeat();
    const runner = new ReconciliationRunner({
      pool: lockGrantingPool(),
      sweepers: [sweeper],
      heartbeat: recorder,
      intervalMs: 60_000,
      logger: collectingLogger(),
    });

    runner.start();
    await vi.advanceTimersByTimeAsync(0);
    await runner.stop();
    await vi.advanceTimersByTimeAsync(300_000);

    expect(calls.count).toBe(1);
    expect(runner.running).toBe(false);
  });

  /**
   * Severing a sweep mid-transaction is safe — it rolls back and the next cycle
   * re-derives it — but finishing is cheaper, and it keeps the shutdown log
   * honest about what actually completed.
   */
  it("waits for the cycle in flight and signals it to wind down", async () => {
    let observedAbort = false;
    let finished = false;
    const slow: Sweeper = {
      name: "sweep.slow",
      run: async (context) => {
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        observedAbort = context.signal.aborted;
        finished = true;
        return EMPTY_SWEEP;
      },
    };
    const { recorder } = fakeHeartbeat();
    const runner = new ReconciliationRunner({
      pool: lockGrantingPool(),
      sweepers: [slow],
      heartbeat: recorder,
      intervalMs: 60_000,
      logger: collectingLogger(),
    });

    runner.start();
    await vi.advanceTimersByTimeAsync(0);

    const stopping = runner.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    await stopping;

    expect(finished).toBe(true);
    expect(observedAbort).toBe(true);
  });

  it("refuses to be restarted, because a stopped runner is a process that is going away", () => {
    const { recorder } = fakeHeartbeat();
    const runner = new ReconciliationRunner({
      pool: lockGrantingPool(),
      sweepers: [],
      heartbeat: recorder,
      intervalMs: 60_000,
      logger: collectingLogger(),
    });

    void runner.stop();
    expect(() => {
      runner.start();
    }).toThrow(/cannot be restarted/);
  });

  it.each([0, -1, Number.NaN])("refuses an interval of %s", (intervalMs) => {
    const { recorder } = fakeHeartbeat();
    expect(
      () =>
        new ReconciliationRunner({
          pool: lockGrantingPool(),
          sweepers: [],
          heartbeat: recorder,
          intervalMs,
          logger: collectingLogger(),
        }),
    ).toThrow(RangeError);
  });
});
