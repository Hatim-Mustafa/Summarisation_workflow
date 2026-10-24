#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

const SCRIPT_DIR = resolve(import.meta.dirname);
const PROJECTS_ROOT = dirname(SCRIPT_DIR);
const DEFAULT_MODEL = "deepseek-v4.1-flash";

function isoSeconds(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function clockifyBase() {
  return (process.env.CLOCKIFY_BASE_URL || "https://api.clockify.me/api/v1").replace(/\/+$/, "");
}

function goBase() {
  return (process.env.OPENCODE_GO_BASE_URL || "https://opencode.ai/inference/go/openai/v1").replace(
    /\/+$/,
    "",
  );
}

function githubApiBase() {
  return (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "");
}

function parseOrgs() {
  return (process.env.GIT_ORG || "")
    .split(/[;,]/)
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

const SYSTEM_PROMPT = `You write concise end-of-day work summaries for a software engineer to send to their supervisor. Use only the supplied activity data. Never invent tasks, projects, hours, or outcomes. If a data source is empty or unavailable, state that plainly instead of guessing.`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(message) {
  process.stderr.write(`${message}\n`);
}

function round(n) {
  return Math.round(n * 100) / 100;
}

function loadDotEnv() {
  const envPath = join(SCRIPT_DIR, ".env");
  if (!existsSync(envPath)) return;
  try {
    process.loadEnvFile(envPath);
  } catch (err) {
    log(`Could not load .env: ${err.message}`);
  }
}

function parseArgs(argv) {
  const opts = {
    repos: [],
    hours: null,
    out: null,
    model: null,
    dryRun: false,
    noSend: false,
    noEmail: false,
    localOnly: false,
    requireGithub: false,
    requireEmail: false,
    requireClockify: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const key = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? null : arg.slice(eq + 1);
    const next = () => {
      if (inline !== null) return inline;
      const value = argv[++i];
      if (value === undefined) throw new Error(`Missing value for ${key}`);
      return value;
    };

    switch (key) {
      case "-r":
      case "--repo":
        opts.repos.push(next());
        break;
      case "--hours":
        opts.hours = Number(next());
        break;
      case "--out":
        opts.out = next();
        break;
      case "--model":
        opts.model = next();
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--no-send":
        opts.noSend = true;
        break;
      case "--no-email":
        opts.noEmail = true;
        break;
      case "--local":
        opts.localOnly = true;
        break;
      case "--require-github":
        opts.requireGithub = true;
        break;
      case "--require-email":
        opts.requireEmail = true;
        break;
      case "--require-clockify":
        opts.requireClockify = true;
        break;
      case "-h":
      case "--help":
        opts.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return opts;
}

function printHelp() {
  console.log(`Usage: node daily-summary.mjs [options]

Options:
  -r, --repo <path>        Local repository to include (repeatable; implies --local)
      --hours <n>          Lookback window in hours (default 24)
      --out <file>         Also write the summary to a file
      --model <id>         OpenCode Go model ID (default ${DEFAULT_MODEL})
      --dry-run            Print collected activity instead of calling the model
      --no-send            Do not post to Google Chat
      --no-email           Do not send the email
      --local              Skip the GitHub API and use local clones only
      --require-github     Fail unless the GitHub API path is used
      --require-email      Fail unless the email is sent
      --require-clockify   Fail if Clockify is unavailable
  -h, --help               Show this help

Environment:
  GIT_REPOS, GIT_ORG, GIT_AUTHOR, SUMMARY_HOURS, SUMMARY_TZ
  CLOCKIFY_API_KEY, CLOCKIFY_WORKSPACE_ID, CLOCKIFY_USER_ID
  OPENCODE_GO_API_KEY, OPENCODE_GO_BASE_URL, SUMMARY_MODEL
  GITHUB_TOKEN or GH_TOKEN, GIT_ORG, GITHUB_MIN_REPOS, GCHAT_WEBHOOK_URL
  GMAIL_USER, GMAIL_TO, GMAIL_APP_PASSWORD
  SMTP_HOST, SMTP_PORT, SMTP_SECURE (optional overrides)

With GH_TOKEN and GIT_ORG set, the script tries the GitHub API first
and falls back to local clones on any API failure. Use --local to force
the local path.

When GCHAT_WEBHOOK_URL is set, the summary is posted to that Google Chat
space automatically. Use --no-send to suppress it for a run.

When GMAIL_USER and GMAIL_APP_PASSWORD are set, the summary is emailed
automatically. Use --no-email to suppress it for a run.

Secrets are read from the environment or a .env file next to this script.
If OPENCODE_GO_API_KEY is not set, the OpenCode Go key is read from the
OpenCode auth store created by \`opencode auth login\`.`);
}

function runGit(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function isGitRepo(path) {
  try {
    return runGit(path, ["rev-parse", "--is-inside-work-tree"]) === "true";
  } catch {
    return false;
  }
}

function gitGlobalEmail() {
  try {
    return execFileSync("git", ["config", "--global", "user.email"], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function repoRoot(path) {
  return resolve(runGit(path, ["rev-parse", "--show-toplevel"]));
}

function discoverSiblingRepos(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name))
    .filter((path) => resolve(path) !== SCRIPT_DIR && existsSync(join(path, ".git")));
}

function remoteOwner(url) {
  const cleaned = url.trim().replace(/\.git\/?$/i, "");
  const scp = cleaned.match(/^[^@\s]+@[^:\s]+:([^/\s]+)\/.+$/);
  if (scp) return scp[1].toLowerCase();
  try {
    const segments = new URL(cleaned).pathname.split("/").filter(Boolean);
    if (segments.length >= 2) return segments[0].toLowerCase();
  } catch {
    return null;
  }
  return null;
}

function remoteOwners(root) {
  let raw = "";
  try {
    raw = runGit(root, ["remote", "-v"]);
  } catch {
    return [];
  }
  const urls = new Set();
  for (const line of raw.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2) urls.add(parts[1]);
  }
  const owners = new Set();
  for (const url of urls) {
    const owner = remoteOwner(url);
    if (owner) owners.add(owner);
  }
  return [...owners];
}

function resolveRepositories(opts, logger = log) {
  let candidates = [...opts.repos];
  let source = "configured";

  if (candidates.length === 0) {
    const configured = process.env.GIT_REPOS || process.env.GIT_REPO || "";
    candidates = configured
      .split(/[;,]/)
      .map((value) => value.trim())
      .filter(Boolean);
  }

  if (candidates.length === 0) {
    const cwd = resolve(process.cwd());
    const insideScriptRepo = cwd === SCRIPT_DIR || cwd.startsWith(SCRIPT_DIR + sep);
    if (!insideScriptRepo && isGitRepo(cwd)) {
      candidates = [cwd];
      source = "current directory";
    } else {
      candidates = discoverSiblingRepos(PROJECTS_ROOT);
      source = "auto-discovered next to this script";
    }
  }

  const roots = [];
  for (const candidate of candidates) {
    const absolute = resolve(candidate);
    if (!existsSync(absolute)) {
      logger(`Skipping missing path: ${absolute}`);
      continue;
    }
    if (!isGitRepo(absolute)) {
      logger(`Skipping non-git path: ${absolute}`);
      continue;
    }
    const root = repoRoot(absolute);
    if (!roots.includes(root)) roots.push(root);
  }

  const orgs = parseOrgs();

  const selected =
    orgs.length === 0
      ? roots
      : roots.filter((root) => {
          const owners = remoteOwners(root);
          const matches = owners.some((owner) => orgs.includes(owner));
          if (!matches) {
            logger(
              `Skipping ${basename(root)}: remote owner ${owners.join(", ") || "unknown"} is not ${orgs.join(", ")}`,
            );
          }
          return matches;
        });

  if (selected.length > 0) {
    logger(`Repositories (${source}): ${selected.map((root) => basename(root)).join(", ")}`);
  } else if (orgs.length > 0) {
    logger(`No repositories matched GIT_ORG=${orgs.join(", ")}`);
  }

  return selected;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function authorForRepo(root) {
  const configured = (process.env.GIT_AUTHOR || "").trim();
  if (configured) {
    if (/^(all|\*)$/i.test(configured)) return null;
    return configured
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  }
  try {
    const email = runGit(root, ["config", "user.email"]).trim();
    return email ? [email] : null;
  } catch {
    return null;
  }
}

function collectRepo(root, from, to) {
  const authors = authorForRepo(root);
  const authorLabel = authors ? authors.join(", ") : null;
  const args = [
    "log",
    "--all",
    `--since=${from.toISOString()}`,
    `--until=${to.toISOString()}`,
    "--pretty=format:%x1e%H%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b",
  ];
  for (const author of authors || []) args.push(`--author=${escapeRegex(author)}`);

  let raw = "";
  try {
    raw = runGit(root, args);
  } catch (err) {
    log(`git log failed for ${root}: ${err.message}`);
    return { name: basename(root), path: root, author: authorLabel, commits: [] };
  }

  if (!raw) return { name: basename(root), path: root, author: authorLabel, commits: [] };

  const commits = [];

  for (const chunk of raw.split("\x1e")) {
    if (!chunk.trim()) continue;
    const fields = chunk.split("\x1f");
    const [hash, authorName, authorEmail, authoredAt, subject, ...bodyParts] = fields;
    const bodyRaw = bodyParts.join("\x1f").trim();

    let insertions = 0;
    let deletions = 0;
    let fileCount = 0;
    const files = [];

    try {
      const numstat = runGit(root, ["show", "--numstat", "--format=", hash]);
      for (const line of numstat.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const [additions, removed, file] = line.split("\t");
        if (!file) continue;
        fileCount += 1;
        if (/^\d+$/.test(additions)) insertions += Number(additions);
        if (/^\d+$/.test(removed)) deletions += Number(removed);
        if (files.length < 20) files.push(file);
      }
    } catch {
      fileCount = 0;
    }

    commits.push({
      hash,
      shortHash: hash.slice(0, 8),
      author: authorName,
      email: authorEmail,
      authoredAt,
      subject,
      body: bodyRaw.length > 800 ? `${bodyRaw.slice(0, 800)}...` : bodyRaw,
      filesChanged: fileCount,
      files,
      insertions,
      deletions,
    });
  }

  return { name: basename(root), path: root, author: authorLabel, commits };
}

function collectGit(roots, from, to) {
  const repositories = [];
  let totalCommits = 0;
  let totalInsertions = 0;
  let totalDeletions = 0;
  let totalFiles = 0;

  for (const root of roots) {
    const repo = collectRepo(root, from, to);
    if (repo.commits.length === 0) continue;
    repositories.push(repo);
    totalCommits += repo.commits.length;
    for (const commit of repo.commits) {
      totalInsertions += commit.insertions;
      totalDeletions += commit.deletions;
      totalFiles += commit.filesChanged;
    }
    log(`${repo.name}: ${repo.commits.length} commit(s)${repo.author ? ` by ${repo.author}` : ""}`);
  }

  return {
    scannedRepositories: roots.length,
    repositoriesWithCommits: repositories.length,
    totalCommits,
    totalInsertions,
    totalDeletions,
    totalFiles,
    repositories,
  };
}

function githubHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "daily-summary/1.0",
  };
}

async function githubFetch(path, token, params = {}) {
  const url = new URL(githubApiBase() + path);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }

  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: githubHeaders(token),
        signal: AbortSignal.timeout(30000),
      });

      if (!res.ok) {
        const body = (await res.text()).slice(0, 500);
        const error = new Error(`GitHub ${path} failed (${res.status})${body ? `: ${body}` : ""}`);
        error.status = res.status;
        if ((res.status === 429 || res.status >= 500) && attempt < 3) {
          lastError = error;
          await sleep(attempt * 2000);
          continue;
        }
        throw error;
      }

      if (res.status === 204) return null;
      return res.json();
    } catch (err) {
      lastError = err;
      const retryable =
        err.name === "TimeoutError" ||
        err.name === "AbortError" ||
        /fetch failed/i.test(err.message || "");
      if (retryable && attempt < 3) {
        await sleep(attempt * 2000);
        continue;
      }
      throw err;
    }
  }

  throw lastError || new Error(`GitHub ${path} failed.`);
}

async function githubPaged(path, token, params = {}, maxPages = 20) {
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    const batch = await githubFetch(path, token, { ...params, per_page: 100, page });
    if (!Array.isArray(batch)) break;
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

function githubAuthorFilter(me) {
  const configured = (process.env.GIT_AUTHOR || "").trim();
  if (/^(all|\*)$/i.test(configured)) {
    return { all: true, emails: new Set(), logins: new Set() };
  }

  const emails = new Set();
  const logins = new Set();

  if (configured) {
    for (const value of configured.split(",").map((item) => item.trim()).filter(Boolean)) {
      if (value.includes("@")) emails.add(value.toLowerCase());
      else logins.add(value.toLowerCase());
    }
  } else {
    const globalEmail = gitGlobalEmail();
    if (globalEmail) emails.add(globalEmail.toLowerCase());
    if (me?.email) emails.add(String(me.email).toLowerCase());
    if (me?.login) logins.add(String(me.login).toLowerCase());
  }

  return { all: false, emails, logins };
}

async function collectGitHub(orgs, from, to, token) {
  const me = await githubFetch("/user", token);
  const filter = githubAuthorFilter(me);

  const repoMap = new Map();
  for (const org of orgs) {
    const list = await githubPaged(`/orgs/${encodeURIComponent(org)}/repos`, token, { type: "all" }, 10);
    for (const repo of list) {
      if (repo?.full_name) repoMap.set(repo.full_name, repo);
    }
  }

  const repos = [...repoMap.values()];
  if (repos.length === 0) throw new Error(`no repositories returned for ${orgs.join(", ")}`);

  const minRepos = Number(process.env.GITHUB_MIN_REPOS || 0);
  if (Number.isFinite(minRepos) && minRepos > 0 && repos.length < minRepos) {
    throw new Error(
      `GitHub API returned ${repos.length} repositories, fewer than GITHUB_MIN_REPOS=${minRepos}`,
    );
  }

  const activeRepos = repos.filter((repo) => {
    if (!repo.pushed_at) return false;
    const pushedAt = Date.parse(repo.pushed_at);
    return Number.isFinite(pushedAt) ? pushedAt >= from.getTime() : true;
  });

  log(
    `GitHub API: ${repos.length} repositories in ${orgs.join(", ")} (${activeRepos.length} pushed in the window)`,
  );

  const repositories = [];
  let totalCommits = 0;
  let totalInsertions = 0;
  let totalDeletions = 0;
  let totalFiles = 0;

  for (const repo of activeRepos) {
    const fullName = repo.full_name;
    let branches = [];

    try {
      branches = await githubPaged(`/repos/${fullName}/branches`, token, {}, 3);
    } catch (err) {
      if (err.status === 409 || err.status === 404) {
        log(`${repo.name}: ${err.status === 409 ? "empty repository" : "not accessible"}`);
        continue;
      }
      throw err;
    }

    const bySha = new Map();

    for (const branch of branches) {
      if (!branch?.name) continue;
      let batch = [];
      try {
        batch = await githubPaged(
          `/repos/${fullName}/commits`,
          token,
          {
            sha: branch.name,
            since: from.toISOString(),
            until: to.toISOString(),
          },
          20,
        );
      } catch (err) {
        if (err.status === 409 || err.status === 404) {
          continue;
        }
        throw err;
      }
      for (const item of batch) {
        if (item?.sha) bySha.set(item.sha, item);
      }
    }

    const commits = [];

    for (const item of bySha.values()) {
      const email = String(item.commit?.author?.email || "").toLowerCase();
      const login = String(item.author?.login || "").toLowerCase();
      if (!filter.all && !filter.emails.has(email) && !filter.logins.has(login)) continue;

      let detail = null;
      try {
        detail = await githubFetch(`/repos/${fullName}/commits/${item.sha}`, token);
      } catch (err) {
        if (err.status === 401 || err.status === 403 || err.status === 429) throw err;
        log(`${repo.name} ${item.sha.slice(0, 8)}: file stats unavailable (${err.status || err.message})`);
      }

      const message = String(item.commit?.message || "");
      const newline = message.indexOf("\n");
      const subject = (newline === -1 ? message : message.slice(0, newline)).trim();
      const body = (newline === -1 ? "" : message.slice(newline + 1).trim());
      const files = Array.isArray(detail?.files) ? detail.files : [];
      const insertions = Number(
        detail?.stats?.additions ?? files.reduce((sum, file) => sum + (file.additions || 0), 0),
      );
      const deletions = Number(
        detail?.stats?.deletions ?? files.reduce((sum, file) => sum + (file.deletions || 0), 0),
      );

      commits.push({
        hash: item.sha,
        shortHash: item.sha.slice(0, 8),
        author: item.commit?.author?.name || item.author?.login || "unknown",
        email: item.commit?.author?.email || "",
        authoredAt: item.commit?.author?.date || item.commit?.committer?.date || "",
        subject,
        body: body.length > 800 ? `${body.slice(0, 800)}...` : body,
        filesChanged: files.length,
        files: files.slice(0, 20).map((file) => file.filename),
        insertions,
        deletions,
      });
    }

    if (commits.length === 0) continue;

    commits.sort((a, b) => String(b.authoredAt).localeCompare(String(a.authoredAt)));

    repositories.push({
      name: repo.name,
      path: fullName,
      author: filter.all
        ? null
        : [...filter.emails, ...filter.logins].join(", ") || me?.login || null,
      commits,
    });

    totalCommits += commits.length;
    for (const commit of commits) {
      totalInsertions += commit.insertions;
      totalDeletions += commit.deletions;
      totalFiles += commit.filesChanged;
    }

    log(`${repo.name}: ${commits.length} commit(s)`);
  }

  return {
    scannedRepositories: repos.length,
    activeRepositories: activeRepos.length,
    repositoriesWithCommits: repositories.length,
    totalCommits,
    totalInsertions,
    totalDeletions,
    totalFiles,
    repositories,
  };
}

async function collectClockify(from, to, apiKey, requireIt) {
  const empty = (reason) => ({
    available: false,
    reason,
    workspace: null,
    workspaceId: null,
    userId: null,
    totalHours: 0,
    billableHours: 0,
    runningEntries: 0,
    entriesCount: 0,
    projects: [],
    entries: [],
  });

  if (!apiKey) {
    if (requireIt) throw new Error("CLOCKIFY_API_KEY is not set.");
    return empty("CLOCKIFY_API_KEY is not set");
  }

  async function get(path, params = {}) {
    const url = new URL(clockifyBase() + path);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    const res = await fetch(url, {
      headers: { "X-Api-Key": apiKey, Accept: "application/json" },
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      const text = (await res.text()).slice(0, 300);
      throw new Error(`Clockify ${path} failed (${res.status})${text ? `: ${text}` : ""}`);
    }
    return res.json();
  }

  async function paged(path, extra = {}) {
    const all = [];
    for (let page = 1; page <= 50; page++) {
      const batch = await get(path, { ...extra, page, "page-size": 200 });
      if (!Array.isArray(batch)) break;
      all.push(...batch);
      if (batch.length < 200) break;
    }
    return all;
  }

  try {
    const user = await get("/user");

    let workspaces = [];
    try {
      workspaces = await get("/workspaces");
    } catch {
      workspaces = [];
    }

    const workspaceId =
      (process.env.CLOCKIFY_WORKSPACE_ID || "").trim() ||
      user.activeWorkspace ||
      user.defaultWorkspace ||
      workspaces[0]?.id;

    if (!workspaceId) throw new Error("Could not determine a Clockify workspace ID.");
    const workspace = workspaces.find((item) => item.id === workspaceId);
    const userId = (process.env.CLOCKIFY_USER_ID || "").trim() || user.id;
    if (!userId) throw new Error("Could not determine a Clockify user ID.");

    const queryFrom = new Date(from.getTime() - 12 * 3600 * 1000);
    const queryTo = new Date(to.getTime() + 12 * 3600 * 1000);

    const [rawEntries, projects, clients] = await Promise.all([
      paged(`/workspaces/${workspaceId}/user/${userId}/time-entries`, {
        start: isoSeconds(queryFrom),
        end: isoSeconds(queryTo),
      }),
      paged(`/workspaces/${workspaceId}/projects`),
      paged(`/workspaces/${workspaceId}/clients`).catch(() => []),
    ]);

    const projectById = new Map(projects.map((project) => [project.id, project]));
    const clientById = new Map(clients.map((client) => [client.id, client]));

    const windowStart = from.getTime();
    const windowEnd = to.getTime();
    const seen = new Set();
    const normalized = [];

    for (const raw of rawEntries) {
      if (raw.id) {
        if (seen.has(raw.id)) continue;
        seen.add(raw.id);
      }

      const startIso = raw.timeInterval?.start;
      if (!startIso) continue;
      const start = Date.parse(startIso);
      const endIso = raw.timeInterval?.end || null;
      const end = endIso ? Date.parse(endIso) : windowEnd;
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      if (end <= windowStart || start >= windowEnd) continue;

      const clippedStart = Math.max(start, windowStart);
      const clippedEnd = Math.min(end, windowEnd);
      const hours = (clippedEnd - clippedStart) / 3600000;
      if (hours <= 0) continue;

      const project = raw.projectId ? projectById.get(raw.projectId) : null;
      const projectName = raw.projectId ? project?.name || "Unknown project" : "No project";
      const clientName = project?.clientId ? clientById.get(project.clientId)?.name || null : null;

      normalized.push({
        startIso: new Date(start).toISOString(),
        endIso,
        hours,
        project: projectName,
        client: clientName,
        description: (raw.description || "").trim(),
        billable: Boolean(raw.billable),
        running: !endIso,
      });
    }

    normalized.sort((a, b) => a.startIso.localeCompare(b.startIso));

    const grouped = new Map();
    let totalHours = 0;
    let billableHours = 0;
    let runningEntries = 0;

    for (const entry of normalized) {
      totalHours += entry.hours;
      if (entry.billable) billableHours += entry.hours;
      if (entry.running) runningEntries += 1;

      const key = `${entry.client || ""}::${entry.project}`;
      let item = grouped.get(key);
      if (!item) {
        item = {
          project: entry.project,
          client: entry.client,
          hours: 0,
          billableHours: 0,
          entries: 0,
          descriptions: new Set(),
        };
        grouped.set(key, item);
      }
      item.hours += entry.hours;
      if (entry.billable) item.billableHours += entry.hours;
      item.entries += 1;
      if (entry.description) item.descriptions.add(entry.description);
    }

    const groupedProjects = [...grouped.values()]
      .map((item) => ({
        project: item.project,
        client: item.client,
        hours: round(item.hours),
        billableHours: round(item.billableHours),
        entries: item.entries,
        descriptions: [...item.descriptions].slice(0, 10),
      }))
      .sort((a, b) => b.hours - a.hours);

    return {
      available: true,
      reason: null,
      workspace: workspace?.name || workspaceId,
      workspaceId,
      userId,
      totalHours: round(totalHours),
      billableHours: round(billableHours),
      runningEntries,
      entriesCount: normalized.length,
      projects: groupedProjects,
      entries: normalized.slice(0, 200).map((entry) => ({
        start: entry.startIso,
        end: entry.endIso,
        hours: round(entry.hours),
        project: entry.project,
        client: entry.client,
        description: entry.description,
        billable: entry.billable,
        running: entry.running,
      })),
    };
  } catch (err) {
    if (requireIt) throw err;
    return empty(err.message);
  }
}

function summaryTimeZone() {
  return (process.env.SUMMARY_TZ || "").trim() || undefined;
}

function formatTime(value) {
  if (!value) return "running";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: summaryTimeZone(),
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function promptActivity(activity) {
  let json = JSON.stringify(activity, null, 2);
  if (json.length <= 90000) return json;

  const trimmed = structuredClone(activity);
  for (const repo of trimmed.git.repositories) {
    for (const commit of repo.commits) {
      commit.body = commit.body.slice(0, 200);
      commit.files = commit.files.slice(0, 8);
    }
  }
  json = JSON.stringify(trimmed, null, 2);
  if (json.length <= 90000) return json;

  for (const repo of trimmed.git.repositories) {
    for (const commit of repo.commits) {
      delete commit.body;
      delete commit.files;
    }
  }
  json = JSON.stringify(trimmed, null, 2);
  if (json.length <= 90000) return json;

  return `${json.slice(0, 90000)}\n... [activity data truncated]`;
}

function buildPrompt(activity, hours) {
  return `Create an end-of-day work summary covering the last ${hours} hours.

Rules:
- Return Markdown only, without wrapping the whole answer in a code fence.
- Start with "## Summary": 2-4 sentences describing the main outcomes.
- Add "## Work completed": bullets grouped by project or theme. Mention concrete changes, not raw file lists.
- Add "## Time logged": total hours, billable hours, and a compact per-project breakdown using bullets. Do not use Markdown tables.
- Add "## Follow-ups": anything clearly implied by unfinished work, running timers, or WIP commits. Write "None noted." if there is nothing.
- Keep the whole summary under 250 words.
- If git or Clockify data is missing, say so in one line instead of guessing.

Activity data:
${promptActivity(activity)}`;
}

function resolveApiKey() {
  const fromEnv =
    (process.env.OPENCODE_GO_API_KEY || "").trim() ||
    (process.env.OPENCODE_GO_KEY || "").trim();
  if (fromEnv) return fromEnv;

  const candidates = [
    process.env.OPENCODE_AUTH_FILE,
    process.env.OPENCODE_DATA_DIR ? join(process.env.OPENCODE_DATA_DIR, "auth.json") : null,
    join(homedir(), ".local", "share", "opencode", "auth.json"),
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "opencode", "auth.json") : null,
    process.env.APPDATA ? join(process.env.APPDATA, "opencode", "auth.json") : null,
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const auth = JSON.parse(readFileSync(candidate, "utf8"));
      const entry = auth["opencode-go"]?.key ? auth["opencode-go"] : auth.opencode;
      if (entry?.key) return entry.key;
    } catch {
      continue;
    }
  }

  const genericKey = (process.env.OPENCODE_API_KEY || "").trim();
  if (genericKey) return genericKey;

  throw new Error(
    "No OpenCode Go API key found. Set OPENCODE_GO_API_KEY in .env or run `opencode auth login`.",
  );
}

async function callModel(apiKey, model, prompt) {
  const session = randomUUID();
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: prompt },
  ];

  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${goBase()}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "x-opencode-session": session,
          "User-Agent": "daily-summary/1.0",
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.2,
          max_tokens: 3000,
          stream: false,
        }),
        signal: AbortSignal.timeout(180000),
      });

      if (!res.ok) {
        const body = (await res.text()).slice(0, 500);
        const error = new Error(`OpenCode Go request failed (${res.status})${body ? `: ${body}` : ""}`);
        if ((res.status === 429 || res.status >= 500) && attempt < 3) {
          lastError = error;
          await sleep(attempt * 2000);
          continue;
        }
        throw error;
      }

      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content?.trim();
      if (!content) throw new Error("OpenCode Go returned an empty summary.");
      return { content, usage: data.usage, model: data.model || model };
    } catch (err) {
      lastError = err;
      const retryable =
        err.name === "TimeoutError" ||
        err.name === "AbortError" ||
        /fetch failed/i.test(err.message || "");
      if (retryable && attempt < 3) {
        await sleep(attempt * 2000);
        continue;
      }
      throw err;
    }
  }

  throw lastError || new Error("OpenCode Go request failed.");
}

function stripFence(content) {
  const trimmed = content.trim();
  const match = trimmed.match(/^```(?:markdown|md)?\s*\r?\n([\s\S]*?)\r?\n```$/i);
  return match ? match[1].trim() : trimmed;
}

function toChatText(markdown) {
  let text = markdown
    .replace(/^```[^\n]*\r?\n([\s\S]*?)\r?\n```$/gm, "$1")
    .replace(/^#{1,6}[ \t]+(.+)$/gm, "*$1*")
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/__(.+?)__/g, "_$1_")
    .replace(/^([ \t]*)[-*+][ \t]+/gm, "$1• ")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "$1 ($2)")
    .replace(/^[ \t]*\|[-:|\t ]+\|[ \t]*$/gm, "")
    .replace(/^[ \t]*\|(.+)\|[ \t]*$/gm, (_, row) =>
      `• ${row.split("|").map((cell) => cell.trim()).join(" · ")}`,
    )
    .trim();

  if (text.length > 3800) text = `${text.slice(0, 3800)}\n... (truncated)`;
  return text;
}

async function sendToGoogleChat(webhookUrl, text) {
  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=UTF-8" },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(30000),
      });

      if (!res.ok) {
        const body = (await res.text()).slice(0, 500);
        const error = new Error(`Google Chat webhook failed (${res.status})${body ? `: ${body}` : ""}`);
        if ((res.status === 429 || res.status >= 500) && attempt < 3) {
          lastError = error;
          await sleep(attempt * 2000);
          continue;
        }
        throw error;
      }

      return res.json().catch(() => ({}));
    } catch (err) {
      lastError = err;
      const retryable =
        err.name === "TimeoutError" ||
        err.name === "AbortError" ||
        /fetch failed/i.test(err.message || "");
      if (retryable && attempt < 3) {
        await sleep(attempt * 2000);
        continue;
      }
      throw err;
    }
  }

  throw lastError || new Error("Google Chat webhook failed.");
}

function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function inlineEmailHtml(value) {
  return escapeHtml(value)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/__(.+?)__/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2">$1</a>');
}

function markdownToEmailHtml(markdown) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let inList = false;
  let inTable = false;
  let tableRow = 0;

  const closeList = () => {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  };

  const closeTable = () => {
    if (inTable) {
      out.push("</table>");
      inTable = false;
      tableRow = 0;
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      closeList();
      closeTable();
      continue;
    }

    const heading = line.match(/^(#{1,6})[ \t]+(.+)$/);
    if (heading) {
      closeList();
      closeTable();
      const level = Math.min(heading[1].length + 1, 6);
      out.push(`<h${level}>${inlineEmailHtml(heading[2])}</h${level}>`);
      continue;
    }

    const bullet = line.match(/^[ \t]*[-*+][ \t]+(.+)$/);
    if (bullet) {
      closeTable();
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${inlineEmailHtml(bullet[1])}</li>`);
      continue;
    }

    if (/^[ \t]*\|[-:|\t ]+\|[ \t]*$/.test(line)) continue;

    const table = line.match(/^[ \t]*\|(.+)\|[ \t]*$/);
    if (table) {
      closeList();
      const cells = table[1].split("|").map((cell) => cell.trim());
      if (!inTable) {
        out.push(
          '<table border="1" cellspacing="0" cellpadding="6" style="border-collapse:collapse;font-size:13px">',
        );
        inTable = true;
        tableRow = 0;
      }
      const tag = tableRow === 0 ? "th" : "td";
      out.push(
        `<tr>${cells.map((cell) => `<${tag}>${inlineEmailHtml(cell)}</${tag}>`).join("")}</tr>`,
      );
      tableRow += 1;
      continue;
    }

    closeList();
    closeTable();
    out.push(`<p>${inlineEmailHtml(line)}</p>`);
  }

  closeList();
  closeTable();

  return `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222">${out.join("\n")}</body></html>`;
}

function toEmailText(markdown) {
  return markdown
    .replace(/^#{1,6}[ \t]+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^[ \t]*\|[-:|\t ]+\|[ \t]*$/gm, "")
    .replace(/^[ \t]*\|(.+)\|[ \t]*$/gm, (_, row) =>
      row.split("|").map((cell) => cell.trim()).join(" | "),
    )
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "$1 ($2)")
    .trim();
}

function emailSubject() {
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: summaryTimeZone(),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  return `Daily Work Summary - ${date}`;
}

async function sendEmail({ user, pass, to, summary }) {
  const { default: nodemailer } = await import("nodemailer");
  const host = (process.env.SMTP_HOST || "smtp.gmail.com").trim();
  const port = Number(process.env.SMTP_PORT || 465);
  const secure = (process.env.SMTP_SECURE || "true").toLowerCase() !== "false";

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
    connectionTimeout: 30000,
    greetingTimeout: 30000,
    socketTimeout: 30000,
  });

  try {
    await transporter.sendMail({
      from: `"Daily Summary" <${user}>`,
      to,
      subject: emailSubject(),
      text: toEmailText(summary),
      html: markdownToEmailHtml(summary),
    });
  } finally {
    transporter.close();
  }
}

function fallbackSummary(activity) {
  const lines = ["## Summary"];
  lines.push(
    `Activity from ${formatTime(activity.window.from)} to ${formatTime(activity.window.to)}. The AI summary could not be generated, so this is the raw activity.`,
  );
  lines.push("");
  lines.push("## Work completed");

  if (activity.git.totalCommits === 0) {
    lines.push("- No commits in this window.");
  } else {
    for (const repo of activity.git.repositories) {
      for (const commit of repo.commits) {
        lines.push(`- ${repo.name}: ${commit.subject} (${commit.shortHash})`);
      }
    }
  }

  lines.push("");
  lines.push("## Time logged");
  if (!activity.clockify.available) {
    lines.push(`- Clockify unavailable: ${activity.clockify.reason}`);
  } else if (activity.clockify.entriesCount === 0) {
    lines.push("- No Clockify entries in this window.");
  } else {
    lines.push(`- Total: ${activity.clockify.totalHours}h (${activity.clockify.billableHours}h billable)`);
    for (const project of activity.clockify.projects) {
      lines.push(`- ${project.client ? `${project.client} / ` : ""}${project.project}: ${project.hours}h`);
    }
  }

  return lines.join("\n");
}

async function main() {
  loadDotEnv();
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    printHelp();
    return;
  }

  const hours = Number.isFinite(opts.hours) && opts.hours > 0 ? opts.hours : 24;
  const model = opts.model || (process.env.SUMMARY_MODEL || "").trim() || DEFAULT_MODEL;
  const to = new Date();
  const from = new Date(to.getTime() - hours * 3600 * 1000);

  log(`Window: ${formatTime(from)} -> ${formatTime(to)} (${hours}h)`);

  const orgs = parseOrgs();
  const githubToken = (process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "").trim();
  const configuredRepos = (process.env.GIT_REPOS || process.env.GIT_REPO || "").trim();
  const forceLocal = opts.localOnly || opts.repos.length > 0 || Boolean(configuredRepos);
  let git = null;
  let gitSource = "local";
  let localGit = null;
  let localRoots = null;

  const getLocalRoots = (quiet = false) => {
    if (!localRoots) {
      localRoots = resolveRepositories(opts, quiet ? () => {} : log);
    }
    return localRoots;
  };

  const getLocalGit = (quiet = false) => {
    if (!localGit) {
      localGit = collectGit(getLocalRoots(quiet), from, to);
    }
    return localGit;
  };

  if (forceLocal) {
    log("GitHub API skipped: using explicitly configured local repositories.");
  } else if (!githubToken) {
    log("GitHub API skipped: GITHUB_TOKEN is not set.");
  } else if (orgs.length === 0) {
    log("GitHub API skipped: GIT_ORG is not set.");
  } else {
    log(`Trying GitHub API for ${orgs.join(", ")}...`);
    try {
      git = await collectGitHub(orgs, from, to, githubToken);
      gitSource = "github";
    } catch (err) {
      log(`GitHub API failed: ${err.message}`);
      log("Falling back to local git.");
      git = null;
    }
  }

  if (git && git.totalCommits === 0) {
    const local = getLocalGit(true);
    if (local.totalCommits > 0) {
      log(`GitHub API returned no commits, but local clones have ${local.totalCommits}; using local git.`);
      git = local;
      gitSource = "local";
    }
  }

  if (git && gitSource === "github") {
    const roots = getLocalRoots(true);
    if (git.scannedRepositories < roots.length) {
      const local = getLocalGit(true);
      if (local.totalCommits > 0) {
        log(
          `GitHub API sees only ${git.scannedRepositories} of ${roots.length} local synthova repositories; using local git (check token approval/repository access).`,
        );
        git = local;
        gitSource = "local";
      } else {
        log(
          `Warning: GitHub API sees only ${git.scannedRepositories} of ${roots.length} local synthova repositories (check token approval/repository access).`,
        );
      }
    }
  }

  if (!git) {
    git = getLocalGit();
    gitSource = "local";
  }

  if (opts.requireGithub && (gitSource !== "github" || git.scannedRepositories === 0)) {
    throw new Error(
      "GitHub API was required but was not used. Check GH_TOKEN approval, token repository access, and GIT_ORG.",
    );
  }

  log(`Using ${gitSource === "github" ? "GitHub API" : "local git"} (${git.totalCommits} commit(s)).`);

  const clockifyKey = (process.env.CLOCKIFY_API_KEY || "").trim();
  const clockify = await collectClockify(from, to, clockifyKey, opts.requireClockify);

  if (!clockify.available) {
    log(`Clockify skipped: ${clockify.reason}`);
  } else {
    log(
      `Clockify: ${clockify.totalHours}h across ${clockify.entriesCount} entries (${clockify.billableHours}h billable)`,
    );
  }

  const activity = {
    generatedAt: to.toISOString(),
    window: { from: from.toISOString(), to: to.toISOString(), hours },
    git: { ...git, source: gitSource },
    clockify,
  };

  if (opts.dryRun) {
    console.log(JSON.stringify(activity, null, 2));
    return;
  }

  if (git.scannedRepositories === 0 && !clockifyKey) {
    throw new Error("No git repositories found and CLOCKIFY_API_KEY is not set.");
  }

  if (git.totalCommits === 0 && (!clockify.available || clockify.entriesCount === 0)) {
    console.log(`No git commits or Clockify entries found in the last ${hours} hours.`);
    if (!clockify.available) log(`Clockify: ${clockify.reason}`);
    return;
  }

  const apiKey = resolveApiKey();
  log(`Summarizing with ${model}...`);

  let summary;
  let usage = null;

  try {
    const result = await callModel(apiKey, model, buildPrompt(activity, hours));
    summary = stripFence(result.content);
    usage = result.usage;
  } catch (err) {
    log(`Model call failed: ${err.message}`);
    summary = fallbackSummary(activity);
  }

  if (usage) {
    log(
      `Tokens: ${usage.prompt_tokens ?? "?"} input / ${usage.completion_tokens ?? "?"} output`,
    );
  }

  console.log(summary);

  if (opts.out) {
    const outPath = resolve(opts.out);
    writeFileSync(outPath, `${summary}\n`, "utf8");
    log(`Wrote ${outPath}`);
  }

  const webhookUrl = (process.env.GCHAT_WEBHOOK_URL || "").trim();

  if (opts.noSend) {
    log("Google Chat send skipped (--no-send).");
  } else if (webhookUrl) {
    log("Sending summary to Google Chat...");
    try {
      await sendToGoogleChat(webhookUrl, toChatText(summary));
      log("Sent to Google Chat.");
    } catch (err) {
      log(`Google Chat send failed: ${err.message}`);
      process.exitCode = 1;
    }
  }

  const emailUser = (process.env.GMAIL_USER || process.env.SMTP_USER || "").trim();
  const emailPass =
    (process.env.GMAIL_APP_PASSWORD || "").replace(/\s+/g, "") ||
    (process.env.SMTP_PASS || "").trim();
  const emailTo = (process.env.GMAIL_TO || emailUser).trim();

  const missingEmail = [];
  if (!emailUser) missingEmail.push("GMAIL_USER");
  if (!emailPass) missingEmail.push("GMAIL_APP_PASSWORD");
  if (!emailTo) missingEmail.push("GMAIL_TO");

  if (opts.noEmail) {
    log("Email send skipped (--no-email).");
  } else if (missingEmail.length === 0) {
    log(`Sending summary email to ${emailTo}...`);
    try {
      await sendEmail({ user: emailUser, pass: emailPass, to: emailTo, summary });
      log(`Emailed summary to ${emailTo}.`);
    } catch (err) {
      log(`Email send failed: ${err.message}`);
      process.exitCode = 1;
    }
  } else if (opts.requireEmail) {
    log(`Email required but missing: ${missingEmail.join(", ")}.`);
    process.exitCode = 1;
  } else {
    log(`Email skipped: missing ${missingEmail.join(", ")}.`);
  }
}

main().catch((err) => {
  log(`Error: ${err.message}`);
  process.exitCode = 1;
});
