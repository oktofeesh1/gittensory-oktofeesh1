// Image/binary asset weight-delta analyzer (#1506). Flags a PR that commits or grows a heavy image/font/binary
// blob — repo + CDN/cold-start bloat the textual diff hides behind "Binary files differ". Binary sizes are not in
// the patch, so this is the one analyzer that needs the GitHub API: the git tree at headSha (and baseSha, for
// modified files) is fetched with the request's short-lived token — one recursive call returns every blob's size,
// which also sidesteps the Contents API's 1 MB cap. Pure size arithmetic after that; no external service.
// Fail-safe: returns [] without a token/headSha or when the head tree fetch is not OK; growth findings require a
// matching base size.
import type { EnrichRequest, AssetWeightFinding } from "../types.js";

const MAX_FINDINGS = 50; // keep the brief bounded after evaluating every changed binary candidate
const THRESHOLD_BYTES = 100 * 1024; // flag a newly-added blob >= 100 KB, or growth >= 100 KB
const GITHUB_API = "https://api.github.com";

// Extensions that are genuinely binary (text formats like .svg/.json are excluded — their bytes are in the diff).
const BINARY_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "bmp",
  "tiff",
  "tif",
  "ico",
  "webp",
  "avif",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "eot",
  "mp4",
  "mov",
  "avi",
  "webm",
  "mkv",
  "mp3",
  "wav",
  "flac",
  "ogg",
  "zip",
  "tar",
  "gz",
  "tgz",
  "bz2",
  "7z",
  "rar",
  "xz",
  "pdf",
  "psd",
  "ai",
  "sketch",
  "fig",
  "xcf",
  "exe",
  "dll",
  "so",
  "dylib",
  "bin",
  "dat",
  "wasm",
  "node",
  "jar",
  "class",
]);

interface ScanOptions {
  signal?: AbortSignal;
}

// A single repo path segment (owner or name): word chars, dot, dash only. Whole-segment `.`/`..` are rejected
// separately so they can't traverse. A commit SHA: hex only — we only ever fetch a real object, never an arbitrary ref.
const REPO_SEGMENT = /^[A-Za-z0-9._-]+$/;
const SHA_RE = /^[0-9a-fA-F]{7,64}$/;

function isBinaryAsset(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return dot >= 0 && BINARY_EXTS.has(path.slice(dot + 1).toLowerCase());
}

/** Parse `owner/repo`, rejecting anything that isn't exactly two safe segments — no extra `/`, no `.`/`..`
 *  traversal, no query/fragment characters. This stops a hostile `repoFullName` from redirecting the
 *  token-bearing request to another repository. Returns null when unsafe. */
function parseRepo(
  repoFullName: string,
): { owner: string; repo: string } | null {
  const parts = repoFullName.split("/");
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  for (const seg of [owner, repo]) {
    if (!seg || seg === "." || seg === ".." || !REPO_SEGMENT.test(seg)) {
      return null;
    }
  }
  return { owner: owner!, repo: repo! };
}

/** Fetch every blob's byte size in the repo's git tree at `sha`. One recursive call. Empty map on an invalid SHA
 *  or a non-OK reply; throws on truncated recursive replies so the orchestrator degrades instead of trusting
 *  partial data. `owner`/`repo` are validated by the caller; every segment is URL-encoded here (defense in depth)
 *  so nothing user-derived can break out of the intended API path. */
async function fetchTreeSizes(
  owner: string,
  repo: string,
  sha: string,
  token: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  if (!SHA_RE.test(sha)) return sizes;
  const url = `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(sha)}?recursive=1`;
  const res = await fetchImpl(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "gittensory-review-enrichment",
    },
    signal,
  });
  if (!res.ok) return sizes;
  const json = (await res.json()) as {
    tree?: Array<{ path?: string; type?: string; size?: number }>;
    truncated?: boolean;
  };
  if (json.truncated) throw new Error("github_tree_truncated");
  for (const entry of json.tree ?? []) {
    if (entry.type === "blob" && typeof entry.size === "number" && entry.path) {
      sizes.set(entry.path, entry.size);
    }
  }
  return sizes;
}

/** Analyzer entrypoint: flag heavy binary assets the PR adds or grows past the threshold. Pure size arithmetic over
 *  the GitHub git tree; fail-safe (returns [] without a token or on a failed head tree fetch). */
export async function scanAssetWeight(
  req: EnrichRequest,
  fetchImpl: typeof fetch = fetch,
  options: ScanOptions = {},
): Promise<AssetWeightFinding[]> {
  const token = req.githubToken;
  if (!token || !req.headSha) return [];
  const repo = parseRepo(req.repoFullName);
  if (!repo) return [];

  const binaries = (req.files ?? []).filter(
    (f) => f.status !== "removed" && isBinaryAsset(f.path),
  );
  if (!binaries.length) return [];

  const headSizes = await fetchTreeSizes(
    repo.owner,
    repo.repo,
    req.headSha,
    token,
    fetchImpl,
    options.signal,
  );
  const needBase = binaries.some(
    (f) => f.status === "modified" || f.status === "changed",
  );
  const baseSizes =
    needBase && req.baseSha
      ? await fetchTreeSizes(
          repo.owner,
          repo.repo,
          req.baseSha,
          token,
          fetchImpl,
          options.signal,
        )
      : new Map<string, number>();

  const findings: AssetWeightFinding[] = [];
  for (const file of binaries) {
    const bytes = headSizes.get(file.path);
    if (typeof bytes !== "number") continue;

    if (file.status === "added") {
      if (bytes >= THRESHOLD_BYTES) {
        findings.push({
          path: file.path,
          bytes,
          deltaBytes: bytes,
          status: "added",
        });
      }
      continue;
    }

    if (file.status === "modified" || file.status === "changed") {
      const baseBytes = baseSizes.get(file.path);
      if (typeof baseBytes !== "number") continue;
      const deltaBytes = bytes - baseBytes;
      if (deltaBytes < THRESHOLD_BYTES) continue;
      findings.push({
        path: file.path,
        bytes,
        deltaBytes,
        status: "grown",
      });
    }
  }
  return findings
    .sort((a, b) => b.deltaBytes - a.deltaBytes)
    .slice(0, MAX_FINDINGS);
}
