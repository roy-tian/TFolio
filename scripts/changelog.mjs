import fs from "node:fs"
import path from "node:path"
import process from "node:process"
import { spawnSync } from "node:child_process"

const root = path.resolve(import.meta.dirname, "..")

// Sections in the order they appear; an unparseable subject or unknown type
// falls into "Other changes" rather than being dropped.
const sections = [
  ["feat", "Features"],
  ["fix", "Bug fixes"],
  ["perf", "Performance"],
  ["refactor", "Refactoring"],
  ["revert", "Reverts"],
  ["docs", "Documentation"],
  ["style", "Styles"],
  ["test", "Tests"],
  ["build", "Build"],
  ["ci", "Continuous integration"],
  ["chore", "Chores"],
  ["other", "Other changes"],
]

const sectionTypes = new Set(sections.map(([type]) => type))
const headerPattern = /^(\w+)(?:\(([^)]*)\))?(!)?: (.+)$/
const breakingPattern = /^BREAKING[ -]CHANGE:\s*([\s\S]+)$/m
const fieldSeparator = "\x1f"
const recordSeparator = "\x1e"

function fail(message) {
  console.error(`Changelog error: ${message}`)
  process.exit(1)
}

function git(args, { allowFailure = false } = {}) {
  // The default 1 MB buffer is not enough for a whole-history log.
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })

  if (result.error) {
    fail(`could not run git ${args.join(" ")}: ${result.error.message}`)
  }
  if (result.status !== 0) {
    if (allowFailure) {
      return null
    }
    const details = result.stderr.trim() || `exit code ${result.status ?? "unknown"}`
    fail(`git ${args.join(" ")} failed: ${details}`)
  }

  return result.stdout.trim()
}

function readRepository() {
  const fromWorkflow = process.env.GITHUB_REPOSITORY
  if (fromWorkflow) {
    return fromWorkflow
  }

  const remote = git(["remote", "get-url", "origin"], { allowFailure: true })
  const match = remote && /github\.com[:/](.+?)(?:\.git)?\/?$/.exec(remote)
  if (!match) {
    fail("could not determine the GitHub repository; set GITHUB_REPOSITORY")
  }

  return match[1]
}

function resolveRelease(requestedTag) {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  )
  const tag = requestedTag ?? process.env.RELEASE_TAG ?? `v${packageJson.version}`
  // Notes have to be previewable before the tag exists, so an unknown tag reads
  // the checked-out history instead.
  const tagged = git(["rev-parse", "--verify", "--quiet", `${tag}^{commit}`], {
    allowFailure: true,
  })

  return { tag, revision: tagged ? tag : "HEAD" }
}

function readCommits(revision) {
  const previousTag = git(
    ["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*", `${revision}^`],
    { allowFailure: true },
  )
  const range = previousTag ? `${previousTag}..${revision}` : revision
  const log = git([
    "log",
    "--no-merges",
    `--format=%H%x1f%s%x1f%b%x1e`,
    range,
  ])

  const commits = log
    .split(recordSeparator)
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [hash, subject, body = ""] = record.split(fieldSeparator)
      const header = headerPattern.exec(subject)
      const known = Boolean(header) && sectionTypes.has(header[1])

      return {
        hash,
        body,
        type: known ? header[1] : "other",
        scope: known ? header[2] : undefined,
        subject: known ? header[4] : subject,
        breaking: Boolean(header?.[3]) || breakingPattern.test(body),
      }
    })
    // The version bump that carries the tag describes no change of its own.
    .filter((commit) => !(commit.type === "chore" && commit.scope === "release"))

  return { previousTag, commits }
}

function formatEntry(commit, repository) {
  const scope = commit.scope ? `**${commit.scope}:** ` : ""
  const short = commit.hash.slice(0, 7)
  const link = `https://github.com/${repository}/commit/${commit.hash}`

  return `- ${scope}${commit.subject} ([\`${short}\`](${link}))`
}

function formatBreaking(commit, repository) {
  const entry = formatEntry(commit, repository)
  const notice = breakingPattern.exec(commit.body)
  if (!notice) {
    return entry
  }

  return `${entry}\n  ${notice[1].split(/\n\s*\n/)[0].replace(/\s+/g, " ").trim()}`
}

function buildNotes(tag, revision) {
  const repository = readRepository()
  const { previousTag, commits } = readCommits(revision)
  const breaking = commits.filter((commit) => commit.breaking)
  const lines = []

  if (commits.length === 0) {
    lines.push(`No changes since ${previousTag ?? "the first commit"}.`, "")
  }

  if (breaking.length > 0) {
    lines.push("### Breaking changes", "")
    lines.push(...breaking.map((commit) => formatBreaking(commit, repository)))
    lines.push("")
  }

  for (const [type, title] of sections) {
    const grouped = commits.filter((commit) => commit.type === type)
    if (grouped.length === 0) {
      continue
    }

    lines.push(`### ${title}`, "")
    lines.push(...grouped.map((commit) => formatEntry(commit, repository)))
    lines.push("")
  }

  lines.push(
    previousTag
      ? `**Full changelog**: https://github.com/${repository}/compare/${previousTag}...${tag}`
      : `**Full changelog**: https://github.com/${repository}/commits/${tag}`,
  )

  return `${lines.join("\n")}\n`
}

const args = process.argv.slice(2)
if (args.length > 1) {
  fail("usage: bun run changelog [tag]")
}

const { tag, revision } = resolveRelease(args[0])
process.stdout.write(buildNotes(tag, revision))
