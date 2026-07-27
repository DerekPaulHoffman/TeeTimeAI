import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getClerkFrontendDomain,
  mountDeferredClerkUserButton,
  openDeferredClerkSignIn
} from "./deferred-clerk";

describe("deferred Clerk loader", () => {
  afterEach(() => {
    delete window.Clerk;
    delete window.__internal_ClerkUICtor;
  });

  it("derives the frontend domain from a Clerk publishable key", () => {
    const encodedDomain = window.btoa("clerk.teetimespot.test$");

    expect(
      getClerkFrontendDomain(`pk_test_${encodedDomain}`)
    ).toBe("clerk.teetimespot.test");
  });

  it("rejects malformed publishable keys before creating a script URL", () => {
    expect(() => getClerkFrontendDomain("pk_test_invalid")).toThrow(
      "invalid frontend domain"
    );
  });

  it("opens sign-in through an already initialized browser client", async () => {
    const openSignIn = vi.fn().mockResolvedValue(undefined);
    window.Clerk = {
      load: vi.fn(),
      mountUserButton: vi.fn(),
      openSignIn,
      unmountUserButton: vi.fn()
    };

    await openDeferredClerkSignIn("pk_test_unused");

    expect(openSignIn).toHaveBeenCalledOnce();
  });

  it("mounts and cleans up the signed-in user button", async () => {
    const mountUserButton = vi.fn();
    const unmountUserButton = vi.fn();
    window.Clerk = {
      load: vi.fn(),
      mountUserButton,
      openSignIn: vi.fn(),
      unmountUserButton
    };
    const element = document.createElement("div");

    const cleanup = await mountDeferredClerkUserButton(
      element,
      "pk_test_unused"
    );
    cleanup();

    expect(mountUserButton).toHaveBeenCalledWith(element);
    expect(unmountUserButton).toHaveBeenCalledWith(element);
  });
});
