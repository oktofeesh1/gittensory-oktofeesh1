import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectSelfHostEnvVars,
  renderSelfHostEnvReferenceMarkdown,
  writeSelfHostEnvReference,
} from "../../scripts/gen-selfhost-env-reference.mjs";

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "gt-env-reference-"));
  mkdirSync(join(root, "src", "selfhost", "nested"), { recursive: true });
  writeFileSync(
    join(root, "src", "selfhost", "a.ts"),
    [
      "export const ignored = process.env.not_upper;",
      "const second = process.env.SECOND;",
      "const first = process.env.FIRST;",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "src", "selfhost", "nested", "b.ts"),
    [
      "const duplicateSecond = process.env.SECOND;",
      "const nested = process.env.NESTED_ONLY;",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "src", "server.ts"),
    [
      "const serverOnly = process.env.SERVER_ONLY;",
      "const duplicateFirst = process.env.FIRST;",
      "",
    ].join("\n"),
  );
  return root;
}

describe("gen-selfhost-env-reference (#2081)", () => {
  it("extracts uppercase process.env reads and keeps the first source reference", () => {
    expect(collectSelfHostEnvVars({ rootDir: fixtureRoot() })).toEqual([
      { name: "FIRST", firstReference: "src/selfhost/a.ts:3" },
      { name: "NESTED_ONLY", firstReference: "src/selfhost/nested/b.ts:2" },
      { name: "SECOND", firstReference: "src/selfhost/a.ts:2" },
      { name: "SERVER_ONLY", firstReference: "src/server.ts:1" },
    ]);
  });

  it("renders a deterministic Markdown table with names and references only", () => {
    expect(
      renderSelfHostEnvReferenceMarkdown([
        { name: "FIRST", firstReference: "src/selfhost/a.ts:3" },
        { name: "SECOND", firstReference: "src/selfhost/a.ts:2" },
      ]),
    ).toBe(
      [
        "| Name | First reference |",
        "| --- | --- |",
        "| `FIRST` | `src/selfhost/a.ts:3` |",
        "| `SECOND` | `src/selfhost/a.ts:2` |",
      ].join("\n"),
    );
  });

  it("writes the generated module and reports stale output in check mode", () => {
    const root = fixtureRoot();
    const outputPath = "apps/gittensory-ui/src/lib/selfhost-env-reference.ts";
    const outputAbs = join(root, outputPath);

    const written = writeSelfHostEnvReference({ rootDir: root, outputPath });
    expect(written.changed).toBe(true);
    expect(existsSync(outputAbs)).toBe(true);
    const generated = readFileSync(outputAbs, "utf8");
    expect(generated).toContain("SELFHOST_ENV_REFERENCE_MARKDOWN");
    expect(generated).toContain("src/selfhost/a.ts:3");

    expect(writeSelfHostEnvReference({ rootDir: root, outputPath, check: true }).changed).toBe(false);

    writeFileSync(outputAbs, "stale\n");
    const stale = writeSelfHostEnvReference({ rootDir: root, outputPath, check: true });
    expect(stale.changed).toBe(true);
    expect(readFileSync(outputAbs, "utf8")).toBe("stale\n");

    const rewritten = writeSelfHostEnvReference({ rootDir: root, outputPath });
    expect(rewritten.changed).toBe(true);
    expect(readFileSync(outputAbs, "utf8")).toBe(generated);
  });
});
