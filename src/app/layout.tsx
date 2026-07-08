import type { Metadata } from "next";
import Link from "next/link";
import { Flag } from "lucide-react";

import { OptionalClerkProvider } from "@/components/optional-clerk-provider";
import { AuthNav } from "@/components/auth-nav";
import { hasClerkConfig } from "@/lib/env";
import "./globals.css";

export const metadata: Metadata = {
  title: "Tee Time Spot",
  description: "Find better public golf tee times from your ranked course preferences."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const clerkEnabled = hasClerkConfig();

  return (
    <html lang="en">
      <body>
        <OptionalClerkProvider enabled={clerkEnabled}>
          <div className="site-shell">
            <header className="topbar">
              <Link className="brand" href="/">
                <span className="brand-mark" aria-hidden="true">
                  <Flag size={18} />
                </span>
                Tee Time Spot
              </Link>
              <AuthNav clerkEnabled={clerkEnabled} />
            </header>
            {children}
            <footer className="footer">
              Tee Time Spot alerts only. Bookings stay on the official course site.
            </footer>
          </div>
        </OptionalClerkProvider>
      </body>
    </html>
  );
}
