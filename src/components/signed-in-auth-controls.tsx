"use client";

import { Gauge } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { mountDeferredClerkUserButton } from "@/lib/auth/deferred-clerk";

export function SignedInAuthControls({
  userId
}: {
  userId: string;
}) {
  const [operatorAccess, setOperatorAccess] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/operator/access", {
      cache: "no-store",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      signal: controller.signal
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((result: { operator?: boolean } | null) => {
        if (!controller.signal.aborted) {
          setOperatorAccess(result?.operator === true);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setOperatorAccess(false);
        }
      });

    return () => controller.abort();
  }, [userId]);

  return (
    operatorAccess ? (
      <Link
        aria-label="Site overview"
        className="button button-secondary nav-operator"
        href="/operator"
        prefetch={false}
      >
        <Gauge size={17} />
        <span className="nav-button-label">Site overview</span>
      </Link>
    ) : null
  );
}

export function SignedInUserButton({
  publishableKey
}: {
  publishableKey: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) {
      return;
    }

    let disposed = false;
    let unmount: (() => void) | undefined;
    void mountDeferredClerkUserButton(element, publishableKey)
      .then((cleanup) => {
        if (disposed) {
          cleanup();
        } else {
          unmount = cleanup;
        }
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unmount?.();
    };
  }, [publishableKey]);

  return <div data-testid="user-button" ref={containerRef} />;
}
