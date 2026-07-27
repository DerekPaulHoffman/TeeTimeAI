type ClerkBrowser = {
  load(options: {
    ui: {
      ClerkUI: unknown;
    };
  }): Promise<void>;
  mountUserButton(element: HTMLDivElement): void;
  openSignIn(): Promise<void>;
  unmountUserButton(element: HTMLDivElement): void;
};

declare global {
  interface Window {
    Clerk?: ClerkBrowser;
    __internal_ClerkUICtor?: unknown;
  }
}

let clerkLoadPromise: Promise<ClerkBrowser> | null = null;

export async function openDeferredClerkSignIn(publishableKey: string) {
  const clerk = await loadClerk(publishableKey);
  await clerk.openSignIn();
}

export async function mountDeferredClerkUserButton(
  element: HTMLDivElement,
  publishableKey: string
) {
  const clerk = await loadClerk(publishableKey);
  clerk.mountUserButton(element);
  return () => clerk.unmountUserButton(element);
}

export function getClerkFrontendDomain(publishableKey: string) {
  const encodedDomain = publishableKey.split("_")[2];
  if (!encodedDomain) {
    throw new Error("Clerk publishable key is missing its frontend domain.");
  }

  let domain = "";
  try {
    domain = window.atob(encodedDomain).slice(0, -1);
  } catch {
    throw new Error("Clerk publishable key has an invalid frontend domain.");
  }
  if (
    !domain ||
    !domain.includes(".") ||
    !/^[a-z0-9.-]+$/i.test(domain) ||
    domain.startsWith(".") ||
    domain.endsWith(".")
  ) {
    throw new Error("Clerk publishable key has an invalid frontend domain.");
  }

  return domain;
}

async function loadClerk(publishableKey: string) {
  if (window.Clerk) {
    return window.Clerk;
  }

  clerkLoadPromise ??= initializeClerk(publishableKey).catch((error) => {
    clerkLoadPromise = null;
    throw error;
  });
  return clerkLoadPromise;
}

async function initializeClerk(publishableKey: string) {
  const domain = getClerkFrontendDomain(publishableKey);
  const baseUrl = `https://${domain}/npm`;

  await Promise.all([
    loadScript(`${baseUrl}/@clerk/ui@1/dist/ui.browser.js`),
    loadScript(`${baseUrl}/@clerk/clerk-js@6/dist/clerk.browser.js`, {
      "data-clerk-publishable-key": publishableKey
    })
  ]);

  if (!window.Clerk || !window.__internal_ClerkUICtor) {
    throw new Error("Clerk sign-in did not initialize.");
  }

  await window.Clerk.load({
    ui: {
      ClerkUI: window.__internal_ClerkUICtor
    }
  });
  return window.Clerk;
}

function loadScript(src: string, attributes: Record<string, string> = {}) {
  const existing = Array.from(document.scripts).find(
    (script) => script.src === src
  );
  if (existing?.dataset.loaded === "true") {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    const script = existing ?? document.createElement("script");
    const onLoad = () => {
      script.dataset.loaded = "true";
      resolve();
    };
    const onError = () => reject(new Error(`Unable to load ${src}`));

    script.addEventListener("load", onLoad, { once: true });
    script.addEventListener("error", onError, { once: true });

    if (!existing) {
      script.async = true;
      script.crossOrigin = "anonymous";
      script.src = src;
      for (const [name, value] of Object.entries(attributes)) {
        script.setAttribute(name, value);
      }
      document.head.appendChild(script);
    }
  });
}
