import Image from "next/image";

import type { SearchMode } from "@/lib/searches/search-mode";

export function SearchPageHeader({ mode }: { mode: SearchMode }) {
  const simulatorSelected = mode === "SIMULATOR";

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
      <h1>{simulatorSelected
        ? "Find indoor golf simulators and set a free alert."
        : "Find public golf tee times and set a free alert."}</h1>
      <p className="search-page-header-copy">
        {simulatorSelected
          ? "Find nearby simulator venues and get email alerts for matching one-hour sessions where supported. You book directly with the venue."
          : "Search nearby public golf courses and create a free tee time alert. When a matching opening appears, we email the official booking link and you book directly with the course."}
      </p>
    </div>
  );
}
