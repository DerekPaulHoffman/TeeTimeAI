import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { PROVIDER_CAPABILITIES } from "./provider-capabilities";

const repositoryRoot = process.cwd();
const notesDirectory = resolve(
  repositoryRoot,
  "docs/course-support-provider-notes",
);
const contractFiles = new Set(["README.md", "_template.md", "learning-log.md"]);

function readRepositoryFile(path: string) {
  return readFileSync(resolve(repositoryRoot, path), "utf8");
}

function readNoteFile(filename: string) {
  return readFileSync(resolve(notesDirectory, filename), "utf8");
}

function extractFrontMatter(markdown: string) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
  if (!match) {
    return null;
  }
  return Object.fromEntries(
    match[1]
      .split(/\r?\n/u)
      .map((line) => line.match(/^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/u))
      .filter((entry): entry is RegExpMatchArray => Boolean(entry))
      .map((entry) => [entry[1], entry[2].trim()]),
  );
}

function extractDocumentedFamilies(
  markdown: string,
  linePattern: RegExp,
  terminator?: RegExp,
) {
  const line = markdown.split(/\r?\n/u).find((candidate) =>
    linePattern.test(candidate),
  );
  if (!line) {
    throw new Error(`Missing provider-map line ${linePattern}.`);
  }
  const boundedLine = terminator ? line.split(terminator)[0] : line;
  return [...boundedLine.matchAll(/`([A-Z][A-Z0-9_]*)`/gu)].map(
    (match) => match[1],
  );
}

function sorted(values: Iterable<string>) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function providerFamilyFilename(providerFamily: string) {
  return `${providerFamily.toLocaleLowerCase("en-US").replaceAll("_", "-")}.md`;
}

describe("course-support provider notes", () => {
  it("keeps the provider-note contract and template complete", () => {
    const readme = readNoteFile("README.md");
    const template = readNoteFile("_template.md");
    const learningLog = readNoteFile("learning-log.md");
    const frontMatter = extractFrontMatter(template);

    expect(readme).toContain("Postgres");
    expect(readme).toContain("operational source of truth");
    expect(readme).toContain("Read only `<provider-family>.md`");
    expect(readme).toContain("Do not scan the other family notes");
    expect(readme).toContain("## Retry Novelty Rule");

    expect(frontMatter).toMatchObject({
      schemaVersion: "1",
      providerFamily: "REPLACE_WITH_NORMALIZED_FAMILY",
      registrySupport: "RUNNABLE | NON_SERVER",
      lastReviewedAt: "YYYY-MM-DD",
      lastVerifiedRelease: "null",
    });
    expect(template).toContain("## Current Support State");
    expect(template).toContain("## Approaches That Worked");
    expect(template).toContain(
      "## Approaches That Failed Or Were Inconclusive",
    );
    expect(template).toContain("- Implementation paths:");
    expect(template).toContain("- Focused tests:");
    expect(template).toContain("- Verified release:");
    expect(template).toContain("- Normalized failure class:");
    expect(template).toContain("- Do not retry until:");
    expect(template).toContain("- Next different safe action:");
    expect(template).toContain("## Material Reopen Triggers");
    expect(template).toContain("## Next Novel Action");
    expect(template).toContain("## Change Log");

    expect(learningLog).toContain("### What Helped");
    expect(learningLog).toContain("### What Did Not Work");
    expect(learningLog).toContain("### Process Decision");
    expect(learningLog).toContain("### Success Measures");
  });

  it("keeps every checked-in note free of concrete private references", () => {
    const noteFiles = readdirSync(notesDirectory).filter((filename) =>
      filename.endsWith(".md"),
    );
    expect(noteFiles).toEqual(
      expect.arrayContaining(["README.md", "_template.md", "learning-log.md"]),
    );

    const forbiddenPatterns = [
      { label: "URL", pattern: /https?:\/\//iu },
      {
        label: "email address",
        pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu,
      },
      {
        label: "UUID",
        pattern:
          /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/iu,
      },
      {
        label: "private responder reference",
        pattern: /\bsupport-\d{14}-[a-z0-9]{6,}\b/iu,
      },
      {
        label: "credential assignment",
        pattern:
          /\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*["']?[^\s`]+/iu,
      },
    ];

    for (const filename of noteFiles) {
      const markdown = readNoteFile(filename);
      for (const forbidden of forbiddenPatterns) {
        expect(markdown, `${filename} contains a concrete ${forbidden.label}`).not.toMatch(
          forbidden.pattern,
        );
      }
    }
  });

  it("requires future family notes to match their registry family and support state", () => {
    const familyNotes = readdirSync(notesDirectory).filter(
      (filename) => filename.endsWith(".md") && !contractFiles.has(filename),
    );

    for (const filename of familyNotes) {
      const markdown = readNoteFile(filename);
      const frontMatter = extractFrontMatter(markdown);
      expect(frontMatter, `${filename} requires structured front matter`).not.toBeNull();
      const providerFamily = frontMatter?.providerFamily;
      expect(filename).toBe(providerFamilyFilename(providerFamily));
      const capability =
        PROVIDER_CAPABILITIES[
          providerFamily as keyof typeof PROVIDER_CAPABILITIES
        ];
      expect(capability, `${filename} must name a registry provider family`).toBeDefined();
      expect(frontMatter?.registrySupport).toBe(
        capability.supportsAutomation ? "RUNNABLE" : "NON_SERVER",
      );
      expect(markdown).toContain("## Approaches That Worked");
      expect(markdown).toContain(
        "## Approaches That Failed Or Were Inconclusive",
      );
      expect(markdown).toContain("## Material Reopen Triggers");
      expect(markdown).toContain("## Next Novel Action");
    }
  });

  it("keeps both documented adapter maps aligned with the registry", () => {
    const expectedRunnable = sorted(
      Object.values(PROVIDER_CAPABILITIES)
        .filter((capability) => capability.supportsAutomation)
        .map((capability) => capability.family),
    );
    const expectedNonServer = sorted(
      Object.values(PROVIDER_CAPABILITIES)
        .filter((capability) => !capability.supportsAutomation)
        .map((capability) => capability.family),
    );
    const agents = readRepositoryFile("AGENTS.md");
    const responder = readRepositoryFile("docs/course-support-responder.md");

    const agentsRunnable = extractDocumentedFamilies(
      agents,
      /^- Runnable families:/u,
      /, each only/u,
    );
    const agentsNonServer = extractDocumentedFamilies(
      agents,
      /^- Recognized but not runnable through the server dispatcher today:/u,
    );
    const responderRunnable = extractDocumentedFamilies(
      responder,
      /^- Runnable families are /u,
      / when their required metadata/u,
    );
    const responderNonServer = extractDocumentedFamilies(
      responder,
      /^- `[^`]+`.*remain non-runnable from the server dispatcher/u,
    );

    expect(sorted(agentsRunnable)).toEqual(expectedRunnable);
    expect(sorted(responderRunnable)).toEqual(expectedRunnable);
    expect(sorted(agentsNonServer)).toEqual(expectedNonServer);
    expect(sorted(responderNonServer)).toEqual(expectedNonServer);
  });
});
