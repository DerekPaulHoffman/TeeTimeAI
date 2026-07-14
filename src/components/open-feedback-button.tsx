"use client";

import { MessageSquare } from "lucide-react";

export const OPEN_FEEDBACK_EVENT = "tee-time-spot:open-feedback";

export type FeedbackSentiment = "like" | "dislike" | "broken";

export type OpenFeedbackDetail = {
  message?: string;
  sentiment?: FeedbackSentiment;
};

export function openFeedback(detail: OpenFeedbackDetail = {}) {
  window.dispatchEvent(
    new CustomEvent<OpenFeedbackDetail>(OPEN_FEEDBACK_EVENT, { detail })
  );
}

export function OpenFeedbackButton() {
  return (
    <button
      className="button button-dark"
      type="button"
      onClick={() => openFeedback()}
    >
      <MessageSquare size={16} />
      Open the feedback form
    </button>
  );
}
