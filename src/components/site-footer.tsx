import Link from "next/link";
import { Flag } from "lucide-react";

import { discordInviteUrl } from "@/lib/community";
import { siteDefinition } from "@/lib/seo";

const footerGroups = [
  {
    title: "Product",
    links: [
      { href: "/how-it-works", label: "How it works" },
      { href: "/search", label: "Find a tee time" },
      { href: "/methodology", label: "Methodology" },
      { href: "/dashboard", label: "My alerts" }
    ]
  },
  {
    title: "Golf guides",
    links: [
      { href: "/guides", label: "All guides" },
      { href: "/guides/tee-time-cancellation-alerts", label: "Cancellation alerts" },
      { href: "/guides/public-golf-booking-windows", label: "Booking windows" },
      { href: "/guides/tee-time-alerts-vs-auto-booking", label: "Alerts vs. auto-booking" }
    ]
  },
  {
    title: "Company",
    links: [
      { href: "/about", label: "About" },
      { href: "/contact", label: "Contact" },
      { href: "/privacy", label: "Privacy" },
      { href: "/terms", label: "Terms" }
    ]
  }
] as const;

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="site-footer-grid">
        <div className="site-footer-brand">
          <Link className="site-footer-logo" href="/" aria-label="Tee Time Spot home">
            <span aria-hidden="true">
              <Flag size={16} />
            </span>
            Tee Time Spot
          </Link>
          <p>{siteDefinition}</p>
          <p className="site-footer-boundary">We find the opening. You book directly.</p>
        </div>
        {footerGroups.map((group) => (
          <nav aria-label={group.title} className="site-footer-group" key={group.title}>
            <strong>{group.title}</strong>
            {group.links.map((link) => (
              <Link href={link.href} key={link.href}>
                {link.label}
              </Link>
            ))}
          </nav>
        ))}
      </div>
      <div className="site-footer-bottom">
        <p>© 2026 Tee Time Spot</p>
        <a href={discordInviteUrl} rel="noreferrer" target="_blank">
          Join the golfer community
        </a>
      </div>
    </footer>
  );
}
