"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  Bug,
  MessageCircle,
  MessageSquare,
  ThumbsDown,
  ThumbsUp,
  X
} from "lucide-react";

import { discordInviteUrl } from "@/lib/community";
import { trackWebsiteEvent } from "@/lib/engagement/client";
import { sanitizePagePath } from "@/lib/engagement/page-path";
import { detectWebsiteTrafficClass } from "@/lib/engagement/traffic-class";

type FeedbackSentiment = "like" | "dislike" | "broken";

const sentimentOptions: Array<{
  value: FeedbackSentiment;
  label: string;
  icon: typeof ThumbsUp;
}> = [
  { value: "like", label: "Like", icon: ThumbsUp },
  { value: "dislike", label: "Dislike", icon: ThumbsDown },
  { value: "broken", label: "Broken", icon: Bug }
];

export function FeedbackWidget() {
  const [open, setOpen] = useState(false);
  const [sentiment, setSentiment] = useState<FeedbackSentiment>("like");
  const [message, setMessage] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "sent" | "error">("idle");
  const [error, setError] = useState("");
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) {
      closeButtonRef.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;

    function handleDocumentKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape") return;

      event.preventDefault();
      setOpen(false);
      window.requestAnimationFrame(() => launcherRef.current?.focus());
    }

    document.addEventListener("keydown", handleDocumentKeyDown);
    return () => document.removeEventListener("keydown", handleDocumentKeyDown);
  }, [open]);

  function openPanel() {
    setOpen(true);
    trackWebsiteEvent({ name: "feedback_opened" });
  }

  function closePanel() {
    setOpen(false);
    window.requestAnimationFrame(() => launcherRef.current?.focus());
  }

  async function submitFeedback(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("saving");
    setError("");

    try {
      const response = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sentiment,
          message,
          contactEmail,
          page: typeof window === "undefined" ? undefined : sanitizePagePath(window.location.pathname),
          trafficClass: detectWebsiteTrafficClass()
        })
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "Could not save feedback.");
      }

      trackWebsiteEvent({
        name: "feedback_submitted",
        metadata: { sentiment }
      });
      setStatus("sent");
      setMessage("");
      setContactEmail("");
    } catch (submissionError) {
      setStatus("error");
      setError(
        submissionError instanceof Error ? submissionError.message : "Could not save feedback."
      );
    }
  }

  return (
    <div className="feedback-widget">
      {open ? (
        <form
          aria-labelledby="feedback-panel-title"
          className="feedback-panel"
          onSubmit={submitFeedback}
          role="dialog"
        >
          <div className="feedback-panel-header">
            <div>
              <strong id="feedback-panel-title">Send feedback</strong>
              <span>Tell us what is working or what needs fixing.</span>
            </div>
            <button
              aria-label="Close feedback"
              className="button button-ghost icon-button"
              type="button"
              onClick={closePanel}
              ref={closeButtonRef}
            >
              <X size={17} />
            </button>
          </div>

          <a
            className="feedback-community-link"
            href={discordInviteUrl}
            rel="noreferrer"
            target="_blank"
          >
            <MessageCircle size={18} />
            <span>
              <strong>Have a product suggestion?</strong>
              Join our Discord for ideas and longer feedback.
            </span>
            <ArrowUpRight size={16} />
          </a>

          <div className="feedback-options" role="group" aria-label="Feedback type">
            {sentimentOptions.map((option) => {
              const Icon = option.icon;
              return (
                <button
                  className={sentiment === option.value ? "feedback-option active" : "feedback-option"}
                  key={option.value}
                  type="button"
                  onClick={() => setSentiment(option.value)}
                >
                  <Icon size={16} />
                  {option.label}
                </button>
              );
            })}
          </div>

          <label className="feedback-field">
            Details
            <textarea
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder={
                sentiment === "broken"
                  ? "What broke? What did you expect to happen?"
                  : "What should we know?"
              }
              required={sentiment === "broken"}
            />
          </label>

          <label className="feedback-field">
            Email optional
            <input
              type="email"
              value={contactEmail}
              onChange={(event) => setContactEmail(event.target.value)}
              placeholder="you@example.com"
            />
          </label>

          {status === "sent" ? (
            <div className="alert alert-success" role="status">
              Thanks. Your feedback was saved.
            </div>
          ) : null}
          {status === "error" ? (
            <div className="alert alert-error" role="alert">
              {error}
            </div>
          ) : null}

          <button className="button button-dark" type="submit" disabled={status === "saving"}>
            <MessageSquare size={17} />
            {status === "saving" ? "Sending" : "Send feedback"}
          </button>
        </form>
      ) : null}

      {!open ? (
        <button
          aria-label="Open feedback form"
          className="feedback-launcher"
          ref={launcherRef}
          title="Open feedback form"
          type="button"
          onClick={openPanel}
        >
          <MessageSquare size={18} />
          <span>Feedback</span>
        </button>
      ) : null}
    </div>
  );
}
