"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SaveAnswerRequest, SaveAnswersResponse } from "@lpr/contracts";
import { ApiError, api } from "./api";
import { acknowledge, enqueue, outboxAvailable, pending } from "./outbox";

/**
 * The client autosave engine (PLAN.md Phase 6).
 *
 * Every answer goes into the durable outbox FIRST and is sent afterwards. The
 * order is the whole design: a phone that dies between the two loses nothing,
 * whereas sending first and persisting on failure loses exactly the answers
 * given during the failure it was meant to survive.
 *
 * A flush is triggered by a debounce, and forced by the three moments a mobile
 * browser may stop running the page without warning:
 *
 *   • `blur`            — the participant moved to the next question
 *   • `visibilitychange`— the app went to the background, which on iOS is the
 *                         last callback before the tab may be frozen
 *   • `pagehide`        — navigation or closure, and the only one that fires
 *                         reliably on iOS where `beforeunload` does not
 */

const DEBOUNCE_MS = 800;

export type SaveState = "saved" | "saving" | "pending" | "offline";

export interface AutosaveController {
  readonly state: SaveState;
  /** Queue an answer. Returns once it is durable, not once it is sent. */
  save: (answer: SaveAnswerRequest) => Promise<void>;
  /** Send everything queued now. */
  flush: () => Promise<void>;
  readonly failed: boolean;
}

export function useAutosave(sessionId: string): AutosaveController {
  const [state, setState] = useState<SaveState>("saved");
  const [failed, setFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Guards against two flushes running at once and double-sending. */
  const flushing = useRef(false);

  const flush = useCallback(async () => {
    if (!sessionId || flushing.current) return;

    const queued = outboxAvailable() ? await pending(sessionId) : [];
    if (queued.length === 0) {
      setState("saved");
      return;
    }

    flushing.current = true;
    setState("saving");
    try {
      const response = await api.post<SaveAnswersResponse>(
        `/api/participant/sessions/${sessionId}/answers`,
        { answers: queued.map(({ sessionId: _s, queuedAt: _q, ...answer }) => answer) },
      );

      // Acknowledged by revision, so an answer the participant changed while
      // this request was in flight stays queued rather than being dropped.
      await acknowledge(
        sessionId,
        response.results.map((result) => ({
          questionVersionId: result.questionVersionId,
          clientRevision: result.storedRevision,
        })),
      );

      setFailed(false);
      const remaining = await pending(sessionId);
      setState(remaining.length === 0 ? "saved" : "pending");
    } catch (error) {
      // A network failure is not an error to show: the answers are durable and
      // will go out on the next flush. A REFUSAL is different — a closed window
      // or a completed session means retrying forever would be a lie.
      if (error instanceof ApiError && error.status >= 400 && error.status !== 0) {
        setFailed(true);
        setState("pending");
      } else {
        setState("offline");
      }
    } finally {
      flushing.current = false;
    }
  }, [sessionId]);

  const save = useCallback(
    async (answer: SaveAnswerRequest) => {
      setState("pending");
      if (outboxAvailable()) {
        await enqueue({ ...answer, sessionId, queuedAt: Date.now() });
      }

      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), DEBOUNCE_MS);
    },
    [flush, sessionId],
  );

  useEffect(() => {
    const force = (): void => {
      if (timer.current) clearTimeout(timer.current);
      void flush();
    };

    const onVisibility = (): void => {
      // Only on the way out. Flushing on the way back in would fire on every
      // app switch, and the reconnect handler already covers that case.
      if (document.visibilityState === "hidden") force();
    };

    window.addEventListener("pagehide", force);
    window.addEventListener("online", force);
    document.addEventListener("visibilitychange", onVisibility);

    // Anything left over from a previous visit goes out immediately.
    void flush();

    return () => {
      window.removeEventListener("pagehide", force);
      window.removeEventListener("online", force);
      document.removeEventListener("visibilitychange", onVisibility);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [flush]);

  return { state, save, flush, failed };
}
