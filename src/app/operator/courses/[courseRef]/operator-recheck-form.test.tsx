import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: vi.fn()
  })
}));
vi.mock("./actions", () => ({
  requestRecheckAction: vi.fn()
}));

import { OperatorRecheckForm } from "./operator-recheck-form";

describe("OperatorRecheckForm", () => {
  it("explains redaction and exposes an accessible AI recheck action", () => {
    render(
      <OperatorRecheckForm
        idempotencyKey="operator-recheck-123456"
        incidentCycle={2}
        incidentRevision={7}
        reference="cm_123456789012345678901234"
        statusRevision={4}
      />
    );

    expect(screen.getByRole("heading", { name: "Ask AI to recheck" })).toBeTruthy();
    expect(screen.getByLabelText("What should the AI verify?").getAttribute("maxlength")).toBe(
      "500"
    );
    expect(
      screen.getByText(/URLs, emails, credentials, and identifiers are safely redacted/)
    ).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Request AI recheck" }) as HTMLButtonElement).disabled
    ).toBe(false);
  });
});
