"use client";

import { MessageSquare } from "lucide-react";

export const OPEN_FEEDBACK_EVENT = "tee-time-spot:open-feedback";

export function OpenFeedbackButton() {
  return (
    <button
      className="button button-dark"
      type="button"
      onClick={() => window.dispatchEvent(new Event(OPEN_FEEDBACK_EVENT))}
    >
      <MessageSquare size={16} />
      Open the feedback form
    </button>
  );
}
