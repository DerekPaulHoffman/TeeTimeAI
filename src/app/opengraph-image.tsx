import { ImageResponse } from "next/og";

import { siteName } from "@/lib/seo";

export const alt = "Tee Time Spot public golf tee time alerts";
export const size = {
  width: 1200,
  height: 630
};
export const contentType = "image/png";

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          background: "#f4efe5",
          color: "#14231d",
          display: "flex",
          flexDirection: "column",
          fontFamily: "Arial, sans-serif",
          height: "100%",
          justifyContent: "space-between",
          padding: 72,
          width: "100%"
        }}
      >
        <div
          style={{
            alignItems: "center",
            display: "flex",
            gap: 18
          }}
        >
          <div
            style={{
              alignItems: "center",
              background: "#111d18",
              borderRadius: 999,
              color: "#ffffff",
              display: "flex",
              fontSize: 36,
              height: 76,
              justifyContent: "center",
              width: 76
            }}
          >
            T
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span style={{ color: "#105338", fontSize: 26, fontWeight: 700 }}>
              {siteName}
            </span>
            <span style={{ color: "#5c6c64", fontSize: 22 }}>teetimespot.com</span>
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <h1
            style={{
              fontSize: 82,
              letterSpacing: 0,
              lineHeight: 0.96,
              margin: 0,
              maxWidth: 900
            }}
          >
            Tee time alerts for the public courses you actually play.
          </h1>
          <p
            style={{
              color: "#5c6c64",
              fontSize: 32,
              lineHeight: 1.3,
              margin: 0,
              maxWidth: 820
            }}
          >
            Rank your courses, set your window, and get emailed when matching spots open.
          </p>
        </div>
        <div
          style={{
            alignItems: "center",
            color: "#105338",
            display: "flex",
            fontSize: 26,
            fontWeight: 700,
            gap: 18
          }}
        >
          <span>Pick courses</span>
          <span>|</span>
          <span>We watch</span>
          <span>|</span>
          <span>You book direct</span>
        </div>
      </div>
    ),
    size
  );
}
