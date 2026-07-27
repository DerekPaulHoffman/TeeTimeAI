"use client";

import {
  useState,
  type CSSProperties,
  type ReactNode
} from "react";

import { openDeferredClerkSignIn } from "@/lib/auth/deferred-clerk";

export function DeferredSignInButton({
  children,
  className,
  disabled,
  onClick,
  publishableKey,
  style
}: {
  children: ReactNode;
  className: string;
  disabled?: boolean;
  onClick?: () => void;
  publishableKey: string;
  style?: CSSProperties;
}) {
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  const requestSignIn = () => {
    onClick?.();
    setLoading(true);
    setLoadFailed(false);
    void openDeferredClerkSignIn(publishableKey)
      .catch(() => {
        setLoadFailed(true);
      })
      .finally(() => {
        setLoading(false);
      });
  };

  return (
    <>
      <button
        className={className}
        aria-busy={loading}
        disabled={disabled || loading}
        onClick={() => {
          requestSignIn();
        }}
        style={style}
        type="button"
      >
        {children}
      </button>
      {loadFailed ? (
        <span className="sr-only" role="alert">
          Sign-in could not load. Try again.
        </span>
      ) : null}
    </>
  );
}
