import Link from "next/link";
import { ArrowRight, Check, Flag } from "lucide-react";

import { StructuredData } from "@/components/structured-data";

type Breadcrumb = {
  href: "/" | "/guides";
  label: string;
};

type TocItem = {
  id: string;
  label: string;
};

export function EditorialPage({
  eyebrow,
  title,
  intro,
  summary,
  updated,
  breadcrumbs = [{ href: "/", label: "Home" }],
  toc,
  structuredData,
  children
}: {
  eyebrow: string;
  title: string;
  intro: string;
  summary: string;
  updated?: string;
  breadcrumbs?: Breadcrumb[];
  toc: TocItem[];
  structuredData: unknown;
  children: React.ReactNode;
}) {
  return (
    <main className="editorial-page">
      <StructuredData data={structuredData} />
      <header className="editorial-hero">
        <div className="editorial-hero-inner">
          <nav aria-label="Breadcrumb" className="editorial-breadcrumbs">
            {breadcrumbs.map((breadcrumb) => (
              <span key={breadcrumb.href}>
                <Link href={breadcrumb.href}>{breadcrumb.label}</Link>
                <span aria-hidden="true">/</span>
              </span>
            ))}
            <span aria-current="page">{eyebrow}</span>
          </nav>
          <div className="editorial-hero-grid">
            <div>
              <p className="eyebrow">{eyebrow}</p>
              <h1>{title}</h1>
              <p className="editorial-lede">{intro}</p>
              {updated ? <p className="editorial-updated">Reviewed {updated}</p> : null}
            </div>
            <aside className="editorial-summary" aria-label="Tee Time Spot summary">
              <span className="editorial-summary-icon" aria-hidden="true">
                <Flag size={18} />
              </span>
              <strong>The short version</strong>
              <p>{summary}</p>
            </aside>
          </div>
        </div>
      </header>
      <div className="editorial-layout">
        <aside className="editorial-toc">
          <strong>On this page</strong>
          <nav aria-label="On this page">
            {toc.map((item) => (
              <a href={`#${item.id}`} key={item.id}>
                {item.label}
              </a>
            ))}
          </nav>
        </aside>
        <article className="editorial-article">{children}</article>
      </div>
    </main>
  );
}

export function EditorialSection({
  id,
  eyebrow,
  title,
  children
}: {
  id: string;
  eyebrow?: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="editorial-section" id={id}>
      {eyebrow ? <p className="editorial-section-eyebrow">{eyebrow}</p> : null}
      <h2>{title}</h2>
      {children}
    </section>
  );
}

export function EditorialChecklist({ children }: { children: React.ReactNode }) {
  return <ul className="editorial-checklist">{children}</ul>;
}

export function EditorialCheck({ children }: { children: React.ReactNode }) {
  return (
    <li>
      <span aria-hidden="true">
        <Check size={13} />
      </span>
      <div>{children}</div>
    </li>
  );
}

export function EditorialNote({
  label,
  children
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <aside className="editorial-note">
      <strong>{label}</strong>
      <div>{children}</div>
    </aside>
  );
}

export function EditorialCta({
  title = "Ready to watch your favorite public courses?",
  copy = "Rank up to five courses and tell us when you can play. We will email the official booking link when a matching opening appears."
}: {
  title?: string;
  copy?: string;
}) {
  return (
    <section className="editorial-cta">
      <div>
        <p className="eyebrow">Free public golf alerts</p>
        <h2>{title}</h2>
        <p>{copy}</p>
      </div>
      <Link
        className="button button-primary"
        data-analytics-event="start_search_clicked"
        href="/search"
      >
        Find a tee time
        <ArrowRight size={16} />
      </Link>
    </section>
  );
}
