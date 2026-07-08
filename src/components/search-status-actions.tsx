"use client";

import { useState } from "react";
import { CirclePause, Play, X } from "lucide-react";

type SearchStatus = "ACTIVE" | "PAUSED" | "COMPLETED" | "CANCELLED";

export function SearchStatusActions({
  searchId,
  status
}: {
  searchId: string;
  status: SearchStatus;
}) {
  const [pending, setPending] = useState(false);
  const [localStatus, setLocalStatus] = useState(status);

  async function update(status: SearchStatus) {
    setPending(true);
    const response = await fetch(`/api/searches/${searchId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status })
    });

    if (response.ok) {
      setLocalStatus(status);
    }
    setPending(false);
  }

  return (
    <div className="inline-actions">
      {localStatus === "ACTIVE" ? (
        <button
          className="button button-ghost"
          type="button"
          onClick={() => update("PAUSED")}
          disabled={pending}
          title="Pause search"
        >
          <CirclePause size={16} />
          Pause
        </button>
      ) : (
        <button
          className="button button-ghost"
          type="button"
          onClick={() => update("ACTIVE")}
          disabled={pending}
          title="Resume search"
        >
          <Play size={16} />
          Resume
        </button>
      )}
      <button
        className="button button-ghost"
        type="button"
        onClick={() => update("CANCELLED")}
        disabled={pending}
        title="Cancel search"
      >
        <X size={16} />
        Cancel
      </button>
    </div>
  );
}
