import Image from "next/image";

import type { SearchMode } from "@/lib/searches/search-mode";

const copy = {
  OUTDOOR: {
    title: "Find public golf tee times and set a free alert.",
    description: "Search nearby public golf courses and create a free tee time alert. When a matching opening appears, we email the official booking link and you book directly with the course."
  },
  SIMULATOR: {
    title: "Find indoor golf simulators and set a free alert.",
    description: "Find nearby simulator venues and get email alerts for matching sessions where supported. You book directly with the venue."
  }
} as const;

export function SearchPageHeader({ mode }: { mode: SearchMode }) {
  return (
    <div className="search-page-header">
      <Image
        alt=""
        className="search-page-header-image"
        fetchPriority="high"
        fill
        loading="eager"
        quality={50}
        sizes="100vw"
        src="https://images.unsplash.com/photo-1535131749006-b7f58c99034b?auto=format&fit=crop&w=2400&q=80"
      />
      <p className="eyebrow">Set up your alert</p>
      <h1 className="search-mode-copy">
        {(["OUTDOOR", "SIMULATOR"] as const).map((copyMode) => (
          <span aria-hidden={mode !== copyMode} key={copyMode}>
            {copy[copyMode].title}
          </span>
        ))}
      </h1>
      <p className="search-page-header-copy search-mode-copy">
        {(["OUTDOOR", "SIMULATOR"] as const).map((copyMode) => (
          <span aria-hidden={mode !== copyMode} key={copyMode}>
            {copy[copyMode].description}
          </span>
        ))}
      </p>
    </div>
  );
}
