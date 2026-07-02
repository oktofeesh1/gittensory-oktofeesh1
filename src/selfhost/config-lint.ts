import { parse as parseYaml } from "yaml";
import { MAX_FOCUS_MANIFEST_BYTES, parseFocusManifestContent, type FocusManifest } from "../signals/focus-manifest";

const TOP_LEVEL_FIELDS = [
  "source",
  "wantedPaths",
  "blockedPaths",
  "preferredLabels",
  "linkedIssuePolicy",
  "testExpectations",
  "issueDiscoveryPolicy",
  "maintainerNotes",
  "publicNotes",
  "gate",
  "settings",
  "review",
  "features",
  "contentLane",
] as const;

const TOP_LEVEL_FIELD_SET = new Set<string>(TOP_LEVEL_FIELDS);

export type SelfHostConfigLintResult = {
  ok: boolean;
  warnings: string[];
  recognizedFields: string[];
  summary: string;
};

export function lintManifestText(text: string | null | undefined): SelfHostConfigLintResult {
  const manifest = parseFocusManifestContent(text, "repo_file");
  const recognizedFields = recognizedFieldsFor(manifest);
  const warnings = [
    ...manifest.warnings.map(redactManifestWarning),
    ...unknownTopLevelWarnings(text),
  ];
  if (warnings.length === 0 && recognizedFields.length === 0) {
    warnings.push("Manifest did not define any recognized focus fields.");
  }
  const ok = warnings.length === 0 && recognizedFields.length > 0;
  return {
    ok,
    warnings,
    recognizedFields,
    summary: ok
      ? `Manifest parsed ${recognizedFields.length} recognized field${recognizedFields.length === 1 ? "" : "s"}.`
      : `Manifest has ${warnings.length} warning${warnings.length === 1 ? "" : "s"}.`,
  };
}

function recognizedFieldsFor(manifest: FocusManifest): string[] {
  const present = new Set<string>();
  if (manifest.wantedPaths.length > 0) present.add("wantedPaths");
  if (manifest.blockedPaths.length > 0) present.add("blockedPaths");
  if (manifest.preferredLabels.length > 0) present.add("preferredLabels");
  if (manifest.linkedIssuePolicy !== "optional") present.add("linkedIssuePolicy");
  if (manifest.testExpectations.length > 0) present.add("testExpectations");
  if (manifest.issueDiscoveryPolicy !== "neutral") present.add("issueDiscoveryPolicy");
  if (manifest.maintainerNotes.length > 0) present.add("maintainerNotes");
  if (manifest.publicNotes.length > 0) present.add("publicNotes");
  if (manifest.gate.present) present.add("gate");
  if (Object.keys(manifest.settings).length > 0) present.add("settings");
  if (manifest.review.present) present.add("review");
  if (manifest.features.present) present.add("features");
  if (manifest.contentLane.present) present.add("contentLane");
  return TOP_LEVEL_FIELDS.filter((field) => present.has(field));
}

function unknownTopLevelWarnings(text: string | null | undefined): string[] {
  const trimmed = (text ?? "").trim();
  if (!trimmed || isOversize(trimmed)) return [];
  const parsed = parseTopLevelObject(trimmed);
  if (parsed === null) return [];
  const unknown = Object.keys(parsed)
    .filter((key) => !TOP_LEVEL_FIELD_SET.has(key))
    .map(formatFieldName);
  return unknown.length > 0
    ? [`Manifest contains unknown top-level field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`]
    : [];
}

function parseTopLevelObject(text: string): Record<string, unknown> | null {
  const looksLikeJson = text.startsWith("{") || text.startsWith("[");
  if (looksLikeJson) {
    try {
      const parsed = JSON.parse(text);
      return topLevelObjectOrNull(parsed);
    } catch {
      // YAML flow mappings can start with "{" or "[" while still being valid manifest syntax.
    }
  }
  try {
    return topLevelObjectOrNull(parseYaml(text));
  } catch {
    return null;
  }
}

function topLevelObjectOrNull(parsed: unknown): Record<string, unknown> | null {
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

function isOversize(text: string): boolean {
  return text.length > MAX_FOCUS_MANIFEST_BYTES || new TextEncoder().encode(text).byteLength > MAX_FOCUS_MANIFEST_BYTES;
}

function formatFieldName(name: string): string {
  const trimmed = name.replace(/[^\w.-]/g, "_").slice(0, 80);
  return trimmed || "<blank>";
}

function redactManifestWarning(warning: string): string {
  return warning
    .replace(/; ignoring "[^"]*"\./g, "; ignoring the supplied value.")
    .replace(/; ignoring "[^"]*"/g, "; ignoring the supplied value")
    .replace(/falling back to "[^"]*"/g, "falling back to the default");
}
