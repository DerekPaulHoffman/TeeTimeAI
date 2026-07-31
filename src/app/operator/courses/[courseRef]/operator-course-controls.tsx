"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Link2, ShieldCheck } from "lucide-react";

import type { OperatorCourseDecision } from "@/lib/operator/course-monitoring";
import type { ProviderHandling } from "@/lib/operator/provider-handling";

import {
  setCourseOutcomeAction,
  type OperatorActionState,
  updateOfficialLinksAction
} from "./actions";

const initialState: OperatorActionState = {
  status: "idle",
  message: ""
};

type MutationIdentity = {
  reference: string;
  statusRevision: number;
  incidentCycle: number | null;
  incidentRevision: number | null;
  idempotencyKey: string;
};

type OfficialLinksFormProps = MutationIdentity & {
  website: string | null;
  bookingUrl: string | null;
  provider: string;
  providerLabel: string;
  providerOptions: string[];
  platform: string;
  monitoringPath: string;
  providerHandling: ProviderHandling;
};

export function OfficialLinksForm({
  reference,
  statusRevision,
  incidentCycle,
  incidentRevision,
  idempotencyKey,
  website,
  bookingUrl,
  provider,
  providerLabel,
  providerOptions,
  platform,
  monitoringPath,
  providerHandling
}: OfficialLinksFormProps) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(updateOfficialLinksAction, initialState);
  const [websiteValue, setWebsiteValue] = useState(website ?? "");
  const [bookingUrlValue, setBookingUrlValue] = useState(bookingUrl ?? "");
  const [providerValue, setProviderValue] = useState(provider);
  const changed =
    providerValue.trim() !== provider ||
    websiteValue.trim() !== (website ?? "") ||
    bookingUrlValue.trim() !== (bookingUrl ?? "");

  useEffect(() => {
    if (state.status === "success") {
      router.refresh();
    }
  }, [router, state.status]);

  return (
    <form action={formAction} className="operator-panel operator-official-links">
      <div className="operator-panel-heading">
        <div>
          <h2>
            <Link2 size={18} />
            Provider and official links
          </h2>
          <p>
            Change the provider or either URL, then save once. Verification and a fresh check start
            automatically.
          </p>
        </div>
        <span className="operator-link-status">Editable</span>
      </div>

      <div className="operator-link-context" aria-label="Current monitoring route">
        <span>{providerLabel}</span>
        <span>{platform}</span>
        <span>{monitoringPath}</span>
      </div>

      <MutationFields
        idempotencyKey={idempotencyKey}
        incidentCycle={incidentCycle}
        incidentRevision={incidentRevision}
        reference={reference}
        statusRevision={statusRevision}
      />
      <label>
        Tee-time provider
        <input
          aria-label="Tee-time provider"
          autoComplete="off"
          list="operator-provider-families"
          name="providerFamilyKey"
          onChange={(event) => setProviderValue(event.target.value)}
          placeholder="FOREUP or booking.example.com"
          value={providerValue}
        />
        <small>Use a known provider name or the provider&apos;s booking hostname.</small>
      </label>
      <datalist id="operator-provider-families">
        {providerOptions.map((family) => (
          <option key={family} value={family} />
        ))}
      </datalist>
      <label>
        Official course site
        <input
          autoComplete="url"
          name="website"
          onChange={(event) => setWebsiteValue(event.target.value)}
          placeholder="https://course.example"
          type="url"
          value={websiteValue}
        />
      </label>
      <label>
        Official booking page
        <input
          autoComplete="url"
          name="bookingUrl"
          onChange={(event) => setBookingUrlValue(event.target.value)}
          placeholder="https://course.example/book"
          type="url"
          value={bookingUrlValue}
        />
      </label>
      <div className="operator-provider-handling" aria-label="Current provider handling">
        <strong>{providerHandling.title}</strong>
        <p>{providerHandling.description}</p>
      </div>
      <FormMessage state={state} />
      <button disabled={pending || !changed} type="submit">
        {pending ? "Saving and queueing…" : "Save provider and links"}
      </button>
    </form>
  );
}

type CourseOutcomeFormProps = MutationIdentity;

const outcomeHelp: Record<OperatorCourseDecision, string> = {
  LOCAL_READER:
    "Queue a compatible local-reader check first. If this booking page does not have a reader parser yet, engineering keeps ownership and the course state is left unchanged.",
  WEBSITE_TEMPORARILY_UNAVAILABLE:
    "Keep the alert active, tell golfers the course website is not working correctly, and schedule a future check.",
  PRIVATE_COURSE:
    "Close monitoring because this is a private course, not a public tee-time source.",
  PHONE_OR_MANUAL:
    "Close automatic monitoring and direct golfers to the course’s manual booking process.",
  ACCOUNT_REQUIRED:
    "Close monitoring because tee times cannot be viewed without a course account.",
  CAPTCHA_OR_QUEUE:
    "Close monitoring because a captcha or waiting room blocks signed-out access.",
  OTHER_TECHNICAL_LIMITATION:
    "Close monitoring with a confirmed technical limitation that does not fit another choice."
};

export function CourseOutcomeForm(props: CourseOutcomeFormProps) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(setCourseOutcomeAction, initialState);
  const [decision, setDecision] = useState<OperatorCourseDecision | "">("");
  const help = useMemo(() => (decision ? outcomeHelp[decision] : null), [decision]);

  useEffect(() => {
    if (state.status === "success") {
      router.refresh();
    }
  }, [router, state.status]);

  return (
    <form action={formAction} className="operator-action-card operator-outcome-card">
      <h2>
        <ShieldCheck size={18} />
        Set the course outcome
      </h2>
      <p className="operator-form-help">
        Choose what this course actually is or which monitoring path it needs. No separate evidence
        link or decision note is required.
      </p>
      <MutationFields {...props} />
      <label>
        Course outcome or monitoring path
        <select
          name="decision"
          onChange={(event) =>
            setDecision(event.target.value as OperatorCourseDecision | "")
          }
          required
          value={decision}
        >
          <option disabled value="">
            Choose an outcome
          </option>
          <option value="LOCAL_READER">Use the local tee-time reader</option>
          <option value="WEBSITE_TEMPORARILY_UNAVAILABLE">
            Course website temporarily unavailable
          </option>
          <option value="PRIVATE_COURSE">This is a private course</option>
          <option value="PHONE_OR_MANUAL">Phone or manual booking only</option>
          <option value="ACCOUNT_REQUIRED">Account required to view tee times</option>
          <option value="CAPTCHA_OR_QUEUE">Captcha or waiting room blocks access</option>
          <option value="OTHER_TECHNICAL_LIMITATION">Another technical limitation</option>
        </select>
      </label>
      {help ? <p className="operator-outcome-help">{help}</p> : null}
      <FormMessage state={state} />
      <button disabled={pending || !decision} type="submit">
        {pending
          ? decision === "LOCAL_READER"
            ? "Routing to reader…"
            : decision === "WEBSITE_TEMPORARILY_UNAVAILABLE"
              ? "Saving temporary status…"
            : "Saving final outcome…"
          : decision === "LOCAL_READER"
            ? "Use local reader and recheck"
            : decision === "WEBSITE_TEMPORARILY_UNAVAILABLE"
              ? "Set temporary status"
            : "Set final outcome"}
      </button>
    </form>
  );
}

function MutationFields({
  reference,
  statusRevision,
  incidentCycle,
  incidentRevision,
  idempotencyKey
}: MutationIdentity) {
  return (
    <>
      <input name="reference" type="hidden" value={reference} />
      <input name="statusRevision" type="hidden" value={statusRevision} />
      <input name="incidentCycle" type="hidden" value={incidentCycle ?? ""} />
      <input name="incidentRevision" type="hidden" value={incidentRevision ?? ""} />
      <input name="idempotencyKey" type="hidden" value={idempotencyKey} />
    </>
  );
}

function FormMessage({ state }: { state: OperatorActionState }) {
  return state.status === "idle" ? null : (
    <p
      aria-live="polite"
      className={`operator-form-message operator-form-message-${state.status}`}
      role={state.status === "error" ? "alert" : "status"}
    >
      {state.message}
    </p>
  );
}
