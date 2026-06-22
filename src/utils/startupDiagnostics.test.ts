import { describe, expect, it } from "vitest";

import { buildStartupDiagnostic } from "./startupDiagnostics";

describe("buildStartupDiagnostic", () => {
  it("includes the addon id and version in startup evidence", () => {
    expect(
      buildStartupDiagnostic({
        addonID: "zotero-webai@lineex.dev",
        stage: "startup",
        version: "0.1.0",
      }),
    ).toBe("[zotero-webai@lineex.dev v0.1.0] startup");
  });

  it("includes stage and detail when provided", () => {
    expect(
      buildStartupDiagnostic({
        addonID: "zotero-webai@lineex.dev",
        version: "0.1.0",
        stage: "sidebar-registration-failed",
        detail: "No Zotero window was available",
      }),
    ).toContain("sidebar-registration-failed :: No Zotero window was available");
  });
});
