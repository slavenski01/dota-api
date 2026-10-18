"use client";
import { useEffect, useState } from "react";
import { api } from "./source-errors";

/** Retain observations only while seeking inside the same authorized perspective. */
export function useFrame<T extends { matchId: string }>(url: string | null, scope: string, matchId: string, retry: number) {
  const [result, setResult] = useState<{ scope: string; url: string; frame: T } | null>(null);
  const [failure, setFailure] = useState<{ scope: string; url: string; message: string } | null>(null);
  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    setFailure(null);
    void api<T>(url, { signal: controller.signal }).then(frame => {
      if (controller.signal.aborted) return;
      if (frame.matchId !== matchId) throw new Error("Кадр относится к другому матчу.");
      setResult({ scope, url, frame });
    }).catch(error => {
      if (!controller.signal.aborted) setFailure({ scope, url, message: error.message });
    });
    return () => controller.abort();
  }, [url, scope, matchId, retry]);
  const frame = url && result?.scope === scope ? result.frame : null;
  const error = failure?.scope === scope && failure.url === url ? failure.message : null;
  return { frame, error, pending: !!url && result?.url !== url && !error };
}
