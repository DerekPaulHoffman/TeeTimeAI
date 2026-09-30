"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { RecoveryInput, RecoveryView } from "@/lib/course-recovery/contracts";
import type { CourseCandidate } from "@/lib/places/google";
import type { TeeSearchDetailsInput } from "@/lib/validation/search";
import type { RecoveryDemandView } from "@/lib/course-recovery/demand";
import { DeferredSignInButton } from "@/components/deferred-sign-in-button";
import { detectWebsiteTrafficClass, WEBSITE_TRAFFIC_CLASS_HEADER } from "@/lib/engagement/traffic-class";

export const COURSE_RECOVERY_RECEIPT_KEY = "tee-time-spot-course-recovery";
const STATUS_REFRESH_MS = 15_000;
const ACTIVE_STATUSES = new Set(["QUEUED", "INVESTIGATING", "RETRY_WAIT"]);
const RECEIPT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,100}$/;
type RecoveryReceipt = { id: string; input: RecoveryInput };

function storeReceipt(receipt: RecoveryReceipt) {
  try {
    window.sessionStorage.setItem(COURSE_RECOVERY_RECEIPT_KEY, JSON.stringify(receipt));
  } catch {
    // The durable request still exists when browser storage is unavailable.
  }
}

function readReceipt(): RecoveryReceipt | null {
  try {
    const stored = window.sessionStorage.getItem(COURSE_RECOVERY_RECEIPT_KEY);
    if (!stored || stored.length > 2000) return null;
    const receipt = JSON.parse(stored) as RecoveryReceipt;
    if (typeof receipt.id !== "string" || !RECEIPT_ID_PATTERN.test(receipt.id) ||
        typeof receipt.input?.name !== "string" || receipt.input.name.length > 120 ||
        typeof receipt.input.town !== "string" || receipt.input.town.length > 120) return null;
    // A receipt retains only course identity context, never email or alert authority.
    return { id: receipt.id, input: { name: receipt.input.name, town: receipt.input.town,
      ...(typeof receipt.input.address === "string" && receipt.input.address.length <= 200
        ? { address: receipt.input.address } : {}),
      ...(typeof receipt.input.officialWebsite === "string" && receipt.input.officialWebsite.length <= 500
        ? { officialWebsite: receipt.input.officialWebsite } : {}) } };
  } catch {
    return null;
  }
}

async function responseError(response: Response, fallback: string) {
  if (response.status >= 500) return fallback;
  const body = await response.json().catch(() => null) as { error?: unknown } | null;
  return typeof body?.error === "string" ? body.error : fallback;
}

function publicCourseUrl(value?: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.toString() : null;
  } catch { return null; }
}

export function useCourseRecovery(onVerified: (course: CourseCandidate, input: RecoveryInput) => void) {
  const [recovery, setRecovery] = useState<RecoveryView | null>(null);
  const [receipt, setReceipt] = useState<RecoveryReceipt | null>(null);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const generationRef = useRef(0);

  const applyRecovery = useCallback((view: RecoveryView, input: RecoveryInput) => {
    setRecovery(view);
    setError("");
    if (view.status === "VERIFIED" && view.course) onVerified(view.course, input);
  }, [onVerified]);

  const refresh = useCallback(async (current: RecoveryReceipt, signal?: AbortSignal) => {
    const generation = generationRef.current;
    try {
      const response = await fetch(`/api/courses/recovery/${encodeURIComponent(current.id)}`, {
        cache: "no-store", signal
      });
      if (!response.ok) throw new Error(await responseError(response,
        "We couldn't refresh the course request right now. Your saved request is still retained."));
      const body = await response.json() as { recovery: RecoveryView };
      if (signal?.aborted || generation !== generationRef.current) return;
      if (body.recovery?.id !== current.id) throw new Error("Course status is temporarily unavailable.");
      applyRecovery(body.recovery, current.input);
    } catch (cause) {
      if (!signal?.aborted && generation === generationRef.current) setError(cause instanceof Error
        ? cause.message : "Course status is temporarily unavailable.");
    }
  }, [applyRecovery]);

  useEffect(() => {
    const restored = readReceipt();
    if (!restored) return;
    const restoredGeneration = generationRef.current;
    const controller = new AbortController();
    const frame = window.requestAnimationFrame(() => {
      if (controller.signal.aborted || restoredGeneration !== generationRef.current) return;
      setReceipt(restored);
      setRestoring(true);
      void refresh(restored, controller.signal).finally(() => {
        if (!controller.signal.aborted) setRestoring(false);
      });
    });
    return () => { window.cancelAnimationFrame(frame); controller.abort(); };
  }, [refresh]);

  const recoveryStatus = recovery?.status;
  useEffect(() => {
    if (!receipt || !recoveryStatus || !ACTIVE_STATUSES.has(recoveryStatus)) return;
    const controller = new AbortController();
    let timer: number | undefined;
    const schedule = () => {
      if (document.visibilityState !== "visible") return;
      timer = window.setTimeout(async () => {
        await refresh(receipt, controller.signal);
        if (!controller.signal.aborted) schedule();
      }, STATUS_REFRESH_MS);
    };
    const visibility = () => {
      window.clearTimeout(timer);
      schedule();
    };
    schedule();
    document.addEventListener("visibilitychange", visibility);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [receipt, recoveryStatus, refresh]);

  const start = useCallback(async (input: RecoveryInput) => {
    const generation = ++generationRef.current;
    setSubmitting(true);
    setRecovery(null);
    setReceipt(null);
    setError("");
    try {
      const response = await fetch("/api/courses/recovery", {
        method: "POST",
        headers: { "Content-Type": "application/json", [WEBSITE_TRAFFIC_CLASS_HEADER]: detectWebsiteTrafficClass() },
        body: JSON.stringify(input)
      });
      if (!response.ok) throw new Error(await responseError(response,
        "We couldn't save a course investigation right now. Try Find course again in a moment."));
      const body = await response.json() as { recovery: RecoveryView };
      if (!body.recovery || !RECEIPT_ID_PATTERN.test(body.recovery.id)) throw new Error(
        "We couldn't confirm that your course request was saved. Try again in a moment.");
      if (generation !== generationRef.current) return false;
      const next = { id: body.recovery.id, input };
      storeReceipt(next);
      setReceipt(next);
      applyRecovery(body.recovery, input);
      return true;
    } catch (cause) {
      if (generation === generationRef.current) setError(cause instanceof Error
        ? cause.message : "We couldn't save a course investigation right now. Try again in a moment.");
      return false;
    } finally {
      if (generation === generationRef.current) setSubmitting(false);
    }
  }, [applyRecovery]);

  return { recovery, receipt, error, submitting, restoring, start,
    refresh: () => receipt ? refresh(receipt) : Promise.resolve() };
}

type CourseRecoveryPanelProps = {
  state: ReturnType<typeof useCourseRecovery>;
  signedIn: boolean;
  accountEmail?: string;
  clerkPublishableKey?: string;
  settings: Omit<TeeSearchDetailsInput, "alertEmail">;
  settingsError: string | null;
  onEditDetails: (input: RecoveryInput) => void;
};

export function CourseRecoveryPanel(props: CourseRecoveryPanelProps) {
  return <CourseRecoveryPanelContent key={`${props.state.recovery?.id ?? ""}:${props.signedIn ? props.accountEmail : "signed-out"}`} {...props} />;
}

function CourseRecoveryPanelContent({
  state, signedIn, accountEmail, clerkPublishableKey, settings, settingsError, onEditDetails
}: CourseRecoveryPanelProps) {
  const { recovery, receipt, error, submitting, restoring } = state;
  const [demand, setDemand] = useState<RecoveryDemandView | null>(null);
  const [demandError, setDemandError] = useState("");
  const [saving, setSaving] = useState(false);
  const [demandLoaded, setDemandLoaded] = useState(false);
  const requestId = recovery?.id;
  const demandPath = requestId ? `/api/courses/recovery/${encodeURIComponent(requestId)}/demand` : null;

  const refreshDemand = useCallback(async (signal?: AbortSignal) => {
    if (!signedIn || !demandPath) return;
    try {
        const response = await fetch(demandPath, { cache: "no-store", signal });
        if (!response.ok) throw new Error(await responseError(response, "We couldn't load your saved alert request. Try refreshing its status."));
        const body = await response.json() as { demand: RecoveryDemandView | null };
        if (!signal?.aborted) {
          setDemand(body.demand);
          setDemandLoaded(true);
          setDemandError("");
        }
      } catch (cause) {
        if (!signal?.aborted) setDemandError(cause instanceof Error ? cause.message : "Your alert request is temporarily unavailable.");
      }
  }, [signedIn, demandPath]);

  useEffect(() => {
    const controller = new AbortController();
    const frame = window.requestAnimationFrame(() => { void refreshDemand(controller.signal); });
    return () => { window.cancelAnimationFrame(frame); controller.abort(); };
  }, [refreshDemand]);

  useEffect(() => {
    if (!signedIn || !demandPath || demand?.status !== "WAITING") return;
    const controller = new AbortController();
    let timer: number | undefined;
    const schedule = () => {
      if (document.visibilityState !== "visible") return;
      timer = window.setTimeout(async () => {
        await refreshDemand(controller.signal);
        if (!controller.signal.aborted) schedule();
      }, STATUS_REFRESH_MS);
    };
    const visibility = () => { window.clearTimeout(timer); schedule(); };
    schedule();
    document.addEventListener("visibilitychange", visibility);
    return () => { controller.abort(); window.clearTimeout(timer); document.removeEventListener("visibilitychange", visibility); };
  }, [signedIn, demandPath, demand?.status, refreshDemand]);

  async function changeDemand(method: "POST" | "DELETE") {
    if (!signedIn || !demandPath || (method === "POST" && settingsError)) return;
    setSaving(true);
    setDemandError("");
    try {
      const response = await fetch(demandPath, {
        method,
        headers: { "Content-Type": "application/json", [WEBSITE_TRAFFIC_CLASS_HEADER]: detectWebsiteTrafficClass() },
        ...(method === "POST" ? { body: JSON.stringify({ settings }) } : {})
      });
      if (!response.ok) throw new Error(await responseError(response, "We couldn't update your alert request. Try again in a moment."));
      const body = await response.json() as { demand: RecoveryDemandView | null };
      setDemand(body.demand);
      setDemandLoaded(true);
    } catch (cause) {
      setDemandError(cause instanceof Error ? cause.message : "We couldn't update your alert request. Try again in a moment.");
    } finally { setSaving(false); }
  }

  if (!recovery && !error && !submitting && !restoring) return null;
  const canSave = recovery && ACTIVE_STATUSES.has(recovery.status);
  const officialSiteUrl = publicCourseUrl(recovery?.officialSiteUrl);
  return (
    <section className="course-recovery-panel" aria-label="Missing course request">
      <h3>{receipt ? `Course request · ${receipt.input.name}` : "Course investigation"}</h3>
      {submitting || restoring ? <p role="status">{submitting ? "Saving your course request…" : "Restoring your course request…"}</p> : null}
      {recovery ? <p role="status">{recovery.message}</p> : null}
      {recovery?.status === "VERIFIED" && demand?.status !== "ACTIVATED" ? <p>We verified this public course. Add it from Direct search below to choose it for an alert.</p> : null}
      {recovery && ["NEEDS_DETAILS", "ACCESS_LIMITED"].includes(recovery.status) && recovery.question ? <>
        <p className="course-recovery-question">{recovery.question}</p>
        <button type="button" onClick={() => receipt && onEditDetails(receipt.input)}>Update course details</button>
      </> : null}
      {recovery?.status === "UNRESOLVED" ? <p>We couldn&apos;t verify the course yet. A missing result doesn&apos;t mean the course doesn&apos;t exist. Check its exact name and town, then search again.</p> : null}
      {officialSiteUrl && recovery && ["ACCESS_LIMITED", "NOT_PUBLIC", "UNRESOLVED"].includes(recovery.status) ?
        <p><a href={officialSiteUrl} target="_blank" rel="noreferrer">Official site</a></p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {receipt && !submitting ? <button type="button" onClick={() => void state.refresh()}>Refresh course status</button> : null}
      {demand?.status === "ACTIVATED" ? <p role="status">{demand.teeSearchId ? <>
        Your alert is saved. <Link href="/dashboard">Manage it on your dashboard</Link>.
      </> : demand.message}</p> : null}
      {demand?.status === "WAITING" ? <div className="course-recovery-demand">
        <p role="status">Your alert request is saved to your account. It is not checking tee times yet. Once we verify the course, we&apos;ll start your saved alert.</p>
        <p>Saved requests stay active when you browse or correct another course. <Link href="/dashboard">Manage saved course requests on your dashboard</Link>.</p>
        <button disabled={saving} onClick={() => void changeDemand("DELETE")} type="button">{saving ? "Cancelling…" : "Cancel saved alert request"}</button>
      </div> : null}
      {demand && ["CANCELLED", "EXPIRED", "ACTION_REQUIRED"].includes(demand.status) ? <p role="status">{
        demand.status === "CANCELLED" ? "Your saved alert request was cancelled." : demand.status === "EXPIRED"
          ? "The date for your saved alert request has passed. Create a new alert with a future date after the course is verified."
          : demand.message ?? "This saved alert request cannot start. Wait for the course to be verified before creating a new alert."
      }</p> : null}
      {demand && ["CANCELLED", "EXPIRED", "ACTION_REQUIRED"].includes(demand.status) ?
        <p>This saved request will not restart. Once the course is verified, select it from Direct search to create a new alert with a future date.</p> : null}
      {canSave && !demand ? <div className="course-recovery-demand">
        <p>Save the date, time window and players from the form above while we verify the course. This uses one of your three alert slots. It is not monitoring yet.</p>
        {signedIn ? <>
          <p>Alerts will go to your account email ({accountEmail}) and any extra recipients you add. Saved requests stay active when you browse or correct another course. <Link href="/dashboard">Manage saved course requests on your dashboard</Link>.</p>
          <button disabled={saving || !demandLoaded || Boolean(settingsError)} type="button" onClick={() => void changeDemand("POST")}>
            {saving ? "Saving alert request…" : "Save alert request for this course"}
          </button>
          {settingsError ? <p role="alert">{settingsError}</p> : null}
        </> : clerkPublishableKey ? <DeferredSignInButton className="button button-primary" publishableKey={clerkPublishableKey}>
          Sign in to save an alert request
        </DeferredSignInButton> : <p>Sign in to save an alert request. The course investigation can continue without an account.</p>}
      </div> : null}
      {demandError ? <>
        <p role="alert">{demandError}</p>
        <button type="button" disabled={saving} onClick={() => void refreshDemand()}>Refresh saved alert request</button>
      </> : null}
    </section>
  );
}
