"use client";

import type { SaveAnswerRequest } from "@lpr/contracts";

/**
 * The autosave outbox (PLAN.md Phase 6).
 *
 * A durable queue of answers the server has not acknowledged yet. It survives a
 * reload, a crash, and a tunnel, and drains when the connection returns.
 *
 * ── What this is NOT ────────────────────────────────────────────────────────
 * It is resilience, not offline mode. A participant cannot COMPLETE a
 * questionnaire offline: completion is a server-side decision about required
 * questions and an open window, and letting the client decide it would mean
 * accepting submissions whose window had closed hours earlier.
 *
 * ── Why IndexedDB and not localStorage ──────────────────────────────────────
 * localStorage is synchronous and blocks the main thread, which on a mid-range
 * phone shows up as a typing stutter in a free-text question. It is also
 * string-only, so every read and write costs a JSON round trip.
 *
 * One entry per question, keyed by question id: a later answer to the same
 * question REPLACES the queued one rather than queueing behind it. Draining a
 * backlog of five superseded answers would send four values the participant
 * has already corrected, and the server would ignore them by revision anyway.
 */

const DB_NAME = "lpr-outbox";
const DB_VERSION = 1;
const STORE = "answers";

export interface OutboxEntry extends SaveAnswerRequest {
  readonly sessionId: string;
  readonly queuedAt: number;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        // Keyed by session AND question, so two sessions queued at once do not
        // overwrite each other's answers.
        db.createObjectStore(STORE, { keyPath: ["sessionId", "questionVersionId"] });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("could not open the outbox"));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const request = run(transaction.objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error("outbox operation failed"));
    });
  } finally {
    db.close();
  }
}

export async function enqueue(entry: OutboxEntry): Promise<void> {
  await withStore("readwrite", (store) => store.put(entry));
}

export async function pending(sessionId: string): Promise<OutboxEntry[]> {
  const all = await withStore<OutboxEntry[]>(
    "readonly",
    (store) => store.getAll() as IDBRequest<OutboxEntry[]>,
  );
  return all.filter((entry) => entry.sessionId === sessionId);
}

/**
 * Remove entries the server has acknowledged — but only if they have not been
 * superseded meanwhile.
 *
 * The revision check matters: between sending and acknowledging, the
 * participant may have changed the same answer again. Deleting on the id alone
 * would drop that newer value and it would never reach the server.
 */
export async function acknowledge(
  sessionId: string,
  acknowledged: readonly { questionVersionId: string; clientRevision: number }[],
): Promise<void> {
  const db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE, "readwrite");
      const store = transaction.objectStore(STORE);

      for (const entry of acknowledged) {
        const key: [string, string] = [sessionId, entry.questionVersionId];
        const read = store.get(key);
        read.onsuccess = () => {
          const queued = read.result as OutboxEntry | undefined;
          if (queued && queued.clientRevision <= entry.clientRevision) store.delete(key);
        };
      }

      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(new Error("outbox acknowledge failed"));
    });
  } finally {
    db.close();
  }
}

/** Whether the browser can even offer durability. */
export function outboxAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}
