import { ImageResponse } from "next/og";

import { siteName, socialImageAlt } from "@/lib/seo";

export const alt = socialImageAlt;
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
          overflow: "hidden",
          padding: "54px 62px",
          position: "relative",
          width: "100%"
        }}
      >
        <div
          style={{
            alignItems: "center",
            display: "flex",
            justifyContent: "space-between",
            position: "relative",
            width: "100%"
          }}
        >
          <div
            style={{
              alignItems: "center",
              display: "flex",
              gap: 16
            }}
          >
            <svg
              aria-hidden="true"
              height="64"
              viewBox="0 0 64 64"
              width="64"
              xmlns="http://www.w3.org/2000/svg"
            >
              <rect fill="#105338" height="64" rx="14" width="64" />
              <path
                d="M26 14v38"
                stroke="#ffffff"
                strokeLinecap="round"
                strokeWidth="5"
              />
              <path d="M29 16h22L45 27l6 11H29z" fill="#d9862f" />
              <circle cx="23" cy="52" fill="#ffffff" r="5" />
            </svg>
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ color: "#105338", fontSize: 27, fontWeight: 700 }}>
                {siteName}
              </span>
              <span style={{ color: "#5c6c64", fontSize: 19 }}>teetimespot.com</span>
            </div>
          </div>
          <div
            style={{
              background: "#e7ddca",
              borderRadius: 999,
              color: "#105338",
              display: "flex",
              fontSize: 17,
              fontWeight: 700,
              letterSpacing: 1.1,
              padding: "13px 20px"
            }}
          >
            FREE · PUBLIC GOLF · EMAIL ALERTS
          </div>
        </div>

        <div
          style={{
            alignItems: "center",
            display: "flex",
            flex: 1,
            gap: 54,
            position: "relative",
            width: "100%"
          }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 22,
              width: 582
            }}
          >
            <h1
              style={{
                fontSize: 68,
                letterSpacing: -2.5,
                lineHeight: 0.98,
                margin: 0
              }}
            >
              Your preferred course just opened.
            </h1>
            <p
              style={{
                color: "#53645c",
                fontSize: 28,
                lineHeight: 1.28,
                margin: 0,
                maxWidth: 540
              }}
            >
              We send the official link. You book direct.
            </p>
            <div
              style={{
                alignItems: "center",
                color: "#105338",
                display: "flex",
                fontSize: 18,
                fontWeight: 700,
                gap: 12
              }}
            >
              <span style={stepNumberStyle}>1</span>
              <span>Rank courses</span>
              <span style={stepDividerStyle}>›</span>
              <span style={stepNumberStyle}>2</span>
              <span>Set a window</span>
              <span style={stepDividerStyle}>›</span>
              <span style={stepNumberStyle}>3</span>
              <span>Get alerted</span>
            </div>
          </div>

          <div
            style={{
              alignItems: "center",
              display: "flex",
              height: 390,
              justifyContent: "center",
              position: "relative",
              width: 440
            }}
          >
            <div
              style={{
                background: "#cbd9c8",
                borderRadius: 28,
                height: 286,
                position: "absolute",
                transform: "rotate(-6deg)",
                width: 386
              }}
            />
            <div
              style={{
                background: "#e5c48e",
                borderRadius: 28,
                height: 286,
                position: "absolute",
                transform: "rotate(5deg)",
                width: 386
              }}
            />
            <div
              style={{
                background: "#ffffff",
                border: "1px solid #ded8cc",
                borderRadius: 28,
                boxShadow: "0 22px 50px rgba(20, 35, 29, 0.18)",
                display: "flex",
                flexDirection: "column",
                gap: 19,
                padding: "29px 30px",
                position: "relative",
                width: 400
              }}
            >
              <div
                style={{
                  alignItems: "center",
                  display: "flex",
                  gap: 13
                }}
              >
                <span
                  style={{
                    alignItems: "center",
                    background: "#105338",
                    borderRadius: 999,
                    color: "#ffffff",
                    display: "flex",
                    height: 46,
                    justifyContent: "center",
                    width: 46
                  }}
                >
                  <svg
                    aria-hidden="true"
                    height="24"
                    viewBox="0 0 24 24"
                    width="24"
                    xmlns="http://www.w3.org/2000/svg"
                  >
                    <path
                      d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"
                      fill="none"
                      stroke="#ffffff"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="2"
                    />
                    <path
                      d="M10 21h4"
                      fill="none"
                      stroke="#ffffff"
                      strokeLinecap="round"
                      strokeWidth="2"
                    />
                  </svg>
                </span>
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <span
                    style={{
                      color: "#105338",
                      fontSize: 16,
                      fontWeight: 700,
                      letterSpacing: 1
                    }}
                  >
                    TEE TIME ALERT
                  </span>
                  <span style={{ color: "#7a867f", fontSize: 16 }}>Just now</span>
                </div>
              </div>
              <div
                style={{
                  color: "#14231d",
                  display: "flex",
                  fontSize: 34,
                  fontWeight: 700,
                  lineHeight: 1.08
                }}
              >
                Your #1 course has an opening
              </div>
              <div
                style={{
                  color: "#53645c",
                  display: "flex",
                  fontSize: 20
                }}
              >
                Saturday · 2:10 PM · 3 players
              </div>
              <div
                style={{
                  alignItems: "center",
                  background: "#105338",
                  borderRadius: 12,
                  color: "#ffffff",
                  display: "flex",
                  fontSize: 19,
                  fontWeight: 700,
                  justifyContent: "space-between",
                  padding: "15px 18px"
                }}
              >
                <span>Official booking page</span>
                <span>→</span>
              </div>
            </div>
          </div>
        </div>

        <div
          style={{
            background: "#105338",
            borderRadius: 999,
            bottom: -115,
            height: 190,
            left: -45,
            opacity: 0.08,
            position: "absolute",
            right: -45
          }}
        />
      </div>
    ),
    size
  );
}

const stepNumberStyle = {
  alignItems: "center",
  background: "#e7ddca",
  borderRadius: 999,
  display: "flex",
  height: 30,
  justifyContent: "center",
  width: 30
} as const;

const stepDividerStyle = {
  color: "#9b9f94",
  fontSize: 28,
  fontWeight: 400
} as const;
