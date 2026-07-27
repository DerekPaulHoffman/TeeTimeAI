"use client";

import { useActionState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";

import {
  requestRecheckAction,
  type OperatorRecheckActionState
} from "./actions";

const initialState: OperatorRecheckActionState = {
  status: "idle",
  message: ""
};

type OperatorRecheckFormProps = {
  reference: string;
  statusRevision: number;
  incidentCycle: number | null;
  incidentRevision: number | null;
  idempotencyKey: string;
};

export function OperatorRecheckForm({
  reference,
  statusRevision,
  incidentCycle,
  incidentRevision,
  idempotencyKey
}: OperatorRecheckFormProps) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [state, formAction, pending] = useActionState(requestRecheckAction, initialState);

  useEffect(() => {
    if (state.status !== "success") {
      return;
    }
    formRef.current?.reset();
    router.refresh();
  }, [router, state.status]);

  return (
    <form action={formAction} className="operator-action-card" ref={formRef}>
      <h2>
        <RefreshCw size={17} />
        Ask AI to recheck
      </h2>
      <p className="operator-form-help">
        Add what the AI should verify. URLs, emails, credentials, and identifiers are safely
        redacted before the note is stored.
      </p>
      <input name="reference" type="hidden" value={reference} />
      <input name="statusRevision" type="hidden" value={statusRevision} />
      <input name="incidentCycle" type="hidden" value={incidentCycle ?? ""} />
      <input name="incidentRevision" type="hidden" value={incidentRevision ?? ""} />
      <input name="idempotencyKey" type="hidden" value={idempotencyKey} />
      <label>
        What should the AI verify?
        <textarea maxLength={500} minLength={3} name="note" required rows={4} />
      </label>
      {state.status !== "idle" ? (
        <p
          aria-live="polite"
          className={`operator-form-message operator-form-message-${state.status}`}
          role={state.status === "error" ? "alert" : "status"}
        >
          {state.message}
        </p>
      ) : null}
      <button disabled={pending} type="submit">
        {pending ? "Queueing recheck…" : "Request AI recheck"}
      </button>
    </form>
  );
}
