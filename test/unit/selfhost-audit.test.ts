import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logAudit, extractPayloadContext, extractPayloadType } from "../../src/selfhost/audit";

describe("logAudit", () => {
  const written: string[] = [];

  beforeEach(() => {
    written.length = 0;
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits a JSON line with level:audit for job_complete", () => {
    logAudit({ event: "job_complete", ts: 1000, job_id: 1, payload_type: "review", latency_ms: 50, attempts: 1 });
    expect(written).toHaveLength(1);
    const parsed = JSON.parse(written[0]!) as Record<string, unknown>;
    expect(parsed).toMatchObject({ level: "audit", event: "job_complete", ts: 1000, job_id: 1, payload_type: "review", latency_ms: 50, attempts: 1 });
  });

  it("emits a JSON line for job_dead with error field", () => {
    logAudit({ event: "job_dead", ts: 2000, job_id: "42", latency_ms: 100, attempts: 5, error: "boom" });
    const parsed = JSON.parse(written[0]!) as Record<string, unknown>;
    expect(parsed).toMatchObject({ level: "audit", event: "job_dead", error: "boom" });
    expect(parsed.payload_type).toBeUndefined();
  });

  it("emits a JSON line for job_error", () => {
    logAudit({ event: "job_error", ts: 3000, job_id: 2, latency_ms: 10, attempts: 2, error: "transient" });
    const parsed = JSON.parse(written[0]!) as Record<string, unknown>;
    expect(parsed.event).toBe("job_error");
    expect(parsed.level).toBe("audit");
  });

  it("output ends with a newline", () => {
    logAudit({ event: "job_complete", ts: 0, job_id: 0, latency_ms: 0, attempts: 1 });
    expect(written[0]!).toMatch(/\n$/);
  });

  it("adds a carried OTEL trace id without inventing a current span id", () => {
    logAudit(
      { event: "job_complete", ts: 4000, job_id: 3, latency_ms: 20, attempts: 1 },
      "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
    );
    const parsed = JSON.parse(written[0]!) as Record<string, unknown>;
    expect(parsed.trace_id).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(parsed.span_id).toBeUndefined();
  });
});

describe("extractPayloadType", () => {
  it("returns the top-level type string", () => {
    expect(extractPayloadType(JSON.stringify({ type: "review", other: 1 }))).toBe("review");
  });

  it("returns undefined when type field is a number", () => {
    expect(extractPayloadType(JSON.stringify({ type: 42 }))).toBeUndefined();
  });

  it("returns undefined when type field is null", () => {
    expect(extractPayloadType(JSON.stringify({ type: null }))).toBeUndefined();
  });

  it("returns undefined when type field is absent", () => {
    expect(extractPayloadType(JSON.stringify({ other: "x" }))).toBeUndefined();
  });

  it("returns undefined for non-JSON input", () => {
    expect(extractPayloadType("not-json")).toBeUndefined();
  });

  it("returns undefined for an empty object", () => {
    expect(extractPayloadType("{}")).toBeUndefined();
  });
});

describe("extractPayloadContext", () => {
  it("returns top-level repo and PR fields from internal PR jobs", () => {
    expect(extractPayloadContext(JSON.stringify({ type: "agent-regate-pr", repoFullName: "JSONbored/gittensory", prNumber: 2087 }))).toEqual({
      repo: "JSONbored/gittensory",
      pr_number: 2087,
    });
  });

  it("returns repo-only context for repo-scoped background jobs", () => {
    expect(extractPayloadContext(JSON.stringify({ type: "rag-index-repo", repoFullName: "JSONbored/gittensory" }))).toEqual({
      repo: "JSONbored/gittensory",
    });
  });

  it("returns PR-only context when a webhook payload lacks repository data", () => {
    expect(extractPayloadContext(JSON.stringify({ type: "github-webhook", payload: { pull_request: { number: 87 } } }))).toEqual({
      pr_number: 87,
    });
  });

  it("returns nested repository and pull request fields from GitHub webhook jobs", () => {
    expect(
      extractPayloadContext(JSON.stringify({
        type: "github-webhook",
        payload: {
          repository: { full_name: "JSONbored/gittensory" },
          pull_request: { number: 2087 },
        },
      })),
    ).toEqual({ repo: "JSONbored/gittensory", pr_number: 2087 });
  });

  it("falls back from wrong top-level fields to nested webhook context", () => {
    expect(
      extractPayloadContext(JSON.stringify({
        type: "github-webhook",
        repoFullName: 123,
        prNumber: "2087",
        payload: {
          repository: { full_name: "JSONbored/gittensory" },
          pull_request: { number: 2087 },
        },
      })),
    ).toEqual({ repo: "JSONbored/gittensory", pr_number: 2087 });
  });

  it("extracts PR numbers from PR issue-comment payloads without treating regular issues as PRs", () => {
    expect(
      extractPayloadContext(JSON.stringify({
        type: "github-webhook",
        payload: {
          repository: { full_name: "JSONbored/gittensory" },
          issue: { number: 2087, pull_request: {} },
        },
      })),
    ).toEqual({ repo: "JSONbored/gittensory", pr_number: 2087 });
    expect(
      extractPayloadContext(JSON.stringify({
        type: "github-webhook",
        payload: {
          repository: { full_name: "JSONbored/gittensory" },
          issue: { number: 2087 },
        },
      })),
    ).toEqual({ repo: "JSONbored/gittensory" });
  });

  it("extracts PR numbers from check-run and check-suite pull request arrays", () => {
    expect(
      extractPayloadContext(JSON.stringify({
        type: "github-webhook",
        payload: {
          repository: { full_name: "JSONbored/gittensory" },
          check_run: { pull_requests: [null, { number: "bad" }, { number: 2087 }] },
        },
      })),
    ).toEqual({ repo: "JSONbored/gittensory", pr_number: 2087 });
    expect(
      extractPayloadContext(JSON.stringify({
        type: "github-webhook",
        payload: {
          repository: { full_name: "JSONbored/gittensory" },
          check_suite: { pull_requests: [{ number: 2088 }] },
        },
      })),
    ).toEqual({ repo: "JSONbored/gittensory", pr_number: 2088 });
  });

  it("returns undefined for missing, malformed, and non-object payloads", () => {
    expect(extractPayloadContext(JSON.stringify({ type: "refresh-registry" }))).toBeUndefined();
    expect(extractPayloadContext("not-json")).toBeUndefined();
    expect(extractPayloadContext("null")).toBeUndefined();
    expect(extractPayloadContext("[]")).toBeUndefined();
    expect(extractPayloadContext('"string"')).toBeUndefined();
  });

  it("returns undefined for wrong typed and non-finite context fields", () => {
    expect(
      extractPayloadContext(JSON.stringify({
        type: "github-webhook",
        repoFullName: "",
        prNumber: "2087",
        payload: {
          repository: { full_name: "" },
          pull_request: { number: "2087" },
          issue: { number: "2087", pull_request: {} },
          check_run: { pull_requests: "bad" },
          check_suite: { pull_requests: [] },
        },
      })),
    ).toBeUndefined();
    expect(extractPayloadContext('{"prNumber":1e999}')).toBeUndefined();
  });
});
