import { describe, expect, it } from "vitest";

import {
  buildVerificationContext,
  findForbiddenArchiveEntries,
  findUnexpectedArchiveEntries,
} from "../../scripts/verify-build-artifact-lib.mjs";
import { buildAddonVersionMetadata } from "../../scripts/build-version-lib.mjs";

const pkg = {
  version: "0.8.0",
  config: {
    addonName: "Zotero-WebAI",
    addonRef: "zotero-webai",
  },
};
const buildRoot = "/tmp/zotero-webai-build";

function normalizePathForTest(value: string): string {
  return value.replace(/\\/g, "/");
}

function expectRequiredFile(context: { requiredFiles: string[] }, file: string) {
  expect(context.requiredFiles.map(normalizePathForTest)).toContain(file);
}

function expectMissingRequiredFile(
  context: { requiredFiles: string[] },
  file: string,
) {
  expect(context.requiredFiles.map(normalizePathForTest)).not.toContain(file);
}

describe("build artifact verifier", () => {
  it("uses a release-safe xpi file name", () => {
    const context = buildVerificationContext({
      buildRoot,
      pkg,
      env: {},
    });

    expect(normalizePathForTest(context.xpiPath)).toBe(
      `${buildRoot}/Zotero-WebAI-0.8.0.xpi`,
    );
  });

  it("requires update.json for stable releases", () => {
    const context = buildVerificationContext({
      buildRoot,
      pkg,
      env: {},
    });

    expectRequiredFile(context, `${buildRoot}/update.json`);
    expectMissingRequiredFile(context, `${buildRoot}/update-beta.json`);
  });

  it("requires update-beta.json for prereleases", () => {
    const context = buildVerificationContext({
      buildRoot,
      pkg: {
        ...pkg,
        version: "0.8.0-beta.1",
      },
      env: {},
    });

    expectRequiredFile(context, `${buildRoot}/update-beta.json`);
    expectMissingRequiredFile(context, `${buildRoot}/update.json`);
  });

  it("uses a numeric manifest version and descriptive xpi version for dev builds", () => {
    const context = buildVerificationContext({
      buildRoot,
      pkg,
      env: {
        DS_COPILOT_BUILD_CHANNEL: "dev",
        DS_COPILOT_DEV_NUMBER: "260615123",
      },
    });

    expect(context.addonVersion).toMatchObject({
      channel: "dev",
      displayVersion: "0.8.0-dev.260615123",
      manifestVersion: "0.8.0.260615123",
      updateJsonName: "update-beta.json",
    });
    expect(normalizePathForTest(context.xpiPath)).toBe(
      `${buildRoot}/Zotero-WebAI-0.8.0-dev.260615123.xpi`,
    );
    expectRequiredFile(context, `${buildRoot}/update-beta.json`);
  });

  it("rejects non-numeric dev build numbers before packaging", () => {
    expect(() =>
      buildAddonVersionMetadata({
        baseVersion: "0.8.0",
        env: {
          DS_COPILOT_BUILD_CHANNEL: "dev",
          DS_COPILOT_DEV_NUMBER: "abc",
        },
      }),
    ).toThrow("DS_COPILOT_DEV_NUMBER");
  });

  it("flags forbidden profile and secret files inside the packaged archive", () => {
    expect(
      findForbiddenArchiveEntries([
        "bootstrap.js",
        "content/preferences.xhtml",
        ".env",
        "profile/cookies.sqlite",
        "content/data.db",
        "release-profile/places.sqlite",
      ]),
    ).toEqual([
      ".env",
      "profile/cookies.sqlite",
      "content/data.db",
      "release-profile/places.sqlite",
    ]);
  });

  it("rejects unexpected top-level archive entries outside the plugin payload", () => {
    expect(
      findUnexpectedArchiveEntries([
        "bootstrap.js",
        "content/preferences.xhtml",
        "locale/zh-CN/zotero-webai-preferences.ftl",
        "dev-data/zotero.sqlite",
        "README.md",
      ]),
    ).toEqual(["dev-data/zotero.sqlite", "README.md"]);
  });
});
