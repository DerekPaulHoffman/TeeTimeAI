"use client";

import {
  useState,
  type CSSProperties,
  type ReactNode
} from "react";

import { openDeferredClerkSignIn } from "@/lib/auth/deferred-clerk";

export function DeferredSignInButton({
  ariaLabel,
  children,
  className,
  disabled,
  onClick,
  publishableKey,
  returnTo,
  style
}: {
  ariaLabel?: string;
  children: ReactNode;
  className: string;
  disabled?: boolean;
  onClick?: () => void;
  publishableKey: string;
  returnTo?: string;
  style?: CSSProperties;
}) {
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  const requestSignIn = () => {
    onClick?.();
    setLoading(true);
    setLoadFailed(false);
    const signIn = returnTo ? openDeferredClerkSignIn(publishableKey, returnTo) : openDeferredClerkSignIn(publishableKey);
    void signIn
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
        aria-label={ariaLabel}
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
