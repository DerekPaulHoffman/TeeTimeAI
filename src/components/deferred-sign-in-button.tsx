"use client";

import {
  lazy,
  Suspense,
  useState,
  type CSSProperties,
  type ReactNode
} from "react";

const ClerkSignInDialog = lazy(() => import("./clerk-sign-in-dialog"));

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
  const [dialogRequested, setDialogRequested] = useState(false);

  return (
    <>
      <button
        className={className}
        disabled={disabled}
        onClick={() => {
          onClick?.();
          setDialogRequested(true);
        }}
        style={style}
        type="button"
      >
        {children}
      </button>
      {dialogRequested ? (
        <Suspense fallback={null}>
          <ClerkSignInDialog publishableKey={publishableKey} />
        </Suspense>
      ) : null}
    </>
  );
}
