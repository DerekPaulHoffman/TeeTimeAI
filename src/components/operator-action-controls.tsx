"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { Check, RefreshCw } from "lucide-react";

import {
  type OperatorActionState,
  resolveFeedbackAction,
  retryIncidentAction
} from "@/app/operator/actions";

const INITIAL_OPERATOR_ACTION_STATE: OperatorActionState = {
  status: "idle",
  message: ""
};

export function ResolveFeedbackControl({ feedbackId }: { feedbackId: string }) {
  const [state, action] = useActionState(
    resolveFeedbackAction,
    INITIAL_OPERATOR_ACTION_STATE
  );

  return (
    <form action={action} className="operator-inline-action">
      <input name="feedbackId" type="hidden" value={feedbackId} />
      <SubmitButton icon="check" label="Resolve" pendingLabel="Resolving…" />
      <ActionMessage state={state} />
    </form>
  );
}

export function RetryIncidentControl({ incidentId }: { incidentId: string }) {
  const [state, action] = useActionState(
    retryIncidentAction,
    INITIAL_OPERATOR_ACTION_STATE
  );

  return (
    <form action={action} className="operator-inline-action">
      <input name="incidentId" type="hidden" value={incidentId} />
      <SubmitButton icon="retry" label="Retry sooner" pendingLabel="Queueing…" />
      <ActionMessage state={state} />
    </form>
  );
}

function SubmitButton({
  icon,
  label,
  pendingLabel
}: {
  icon: "check" | "retry";
  label: string;
  pendingLabel: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      className="button button-ghost operator-action-button"
      disabled={pending}
      type="submit"
    >
      {icon === "check" ? (
        <Check size={14} />
      ) : (
        <RefreshCw className={pending ? "is-spinning" : undefined} size={14} />
      )}
      {pending ? pendingLabel : label}
    </button>
  );
}

function ActionMessage({
  state
}: {
  state: { status: "idle" | "success" | "error"; message: string };
}) {
  if (state.status === "idle") return null;
  return (
    <span
      aria-live="polite"
      className={`operator-action-message is-${state.status}`}
      role="status"
    >
      {state.message}
    </span>
  );
}
