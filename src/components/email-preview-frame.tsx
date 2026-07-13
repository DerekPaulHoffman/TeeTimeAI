"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type EmailPreviewFrameProps = {
  className?: string;
  initialHeight?: number;
  srcDoc: string;
  title: string;
};

export function EmailPreviewFrame({
  className,
  initialHeight = 880,
  srcDoc,
  title
}: EmailPreviewFrameProps) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [height, setHeight] = useState(initialHeight);

  const syncHeight = useCallback(() => {
    const document = frameRef.current?.contentDocument;
    if (!document) {
      return;
    }

    const nextHeight = Math.ceil(
      Math.max(
        document.documentElement.scrollHeight,
        document.documentElement.offsetHeight,
        document.body?.scrollHeight ?? 0,
        document.body?.offsetHeight ?? 0
      )
    );

    if (nextHeight > 0) {
      setHeight(nextHeight);
    }
  }, []);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) {
      return;
    }

    let observer: ResizeObserver | null = null;
    const observeDocument = () => {
      observer?.disconnect();
      syncHeight();

      const document = frame.contentDocument;
      if (!document || typeof ResizeObserver === "undefined") {
        return;
      }

      observer = new ResizeObserver(syncHeight);
      observer.observe(document.documentElement);
      if (document.body) {
        observer.observe(document.body);
      }
    };

    frame.addEventListener("load", observeDocument);
    window.addEventListener("resize", syncHeight);
    observeDocument();

    return () => {
      observer?.disconnect();
      frame.removeEventListener("load", observeDocument);
      window.removeEventListener("resize", syncHeight);
    };
  }, [srcDoc, syncHeight]);

  return (
    <iframe
      className={className}
      onLoad={syncHeight}
      ref={frameRef}
      srcDoc={srcDoc}
      style={{ height }}
      title={title}
    />
  );
}
