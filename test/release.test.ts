import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  access,
  copyFile,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { extractReleaseNotes } from "../scripts/release-notes.js";

const project = fileURLToPath(new URL("../", import.meta.url));
const releaseCLI = join(
  project,
  "node_modules/commit-and-tag-version/bin/cli.js",
);
const commitlintCLI = join(project, "node_modules/@commitlint/cli/cli.js");

for (const [bump, expected] of [
  ["patch", "1.2.4"],
  ["minor", "1.3.0"],
  ["major", "2.0.0"],
] as const) {
  test(`release preparation ${bump}: updates both manifests and includes only unreleased commits`, async () => {
    const temporary =
      process.env.TMPDIR ??
      (await access("/tmp/opencode").then(
        () => "/tmp/opencode",
        () => tmpdir(),
      ));
    const directory = await mkdtemp(join(temporary, "jev-release-test-"));
    const git = (...args: string[]) =>
      execFileSync(
        "git",
        [
          "-C",
          directory,
          "-c",
          "user.name=Release Test",
          "-c",
          "user.email=release@example.invalid",
          ...args,
        ],
        { encoding: "utf8" },
      ).trim();
    try {
      git("init", "-b", "main");
      git("remote", "add", "origin", "https://github.com/example/plugin.git");
      await copyFile(
        join(project, ".versionrc.json"),
        join(directory, ".versionrc.json"),
      );
      await writeFile(
        join(directory, "package.json"),
        JSON.stringify({ name: "fixture", version: "1.2.3" }),
      );
      await writeFile(
        join(directory, "package-lock.json"),
        JSON.stringify({
          name: "fixture",
          version: "1.2.3",
          lockfileVersion: 3,
          packages: { "": { name: "fixture", version: "1.2.3" } },
        }),
      );
      await writeFile(
        join(directory, "CHANGELOG.md"),
        "# Changelog\n\n## 1.2.3\n\n- Already released.\n",
      );
      git("add", ".");
      git("commit", "-m", "feat: already released");
      git("tag", "v1.2.3");
      for (const message of [
        "feat(router): add routing",
        "fix(router): handle timeouts",
        "ci: validate commits",
        "feat!: remove the old option\n\nBREAKING CHANGE: Replace oldOption with newOption.",
      ])
        git("commit", "--allow-empty", "-m", message);
      const before = git("rev-parse", "HEAD");
      execFileSync(
        process.execPath,
        [
          releaseCLI,
          "--skip.commit",
          "--skip.tag",
          "--release-as",
          bump,
          "--silent",
        ],
        {
          cwd: directory,
          env: { ...process.env, HUSKY: "0" },
          encoding: "utf8",
        },
      );
      assert.equal(
        JSON.parse(await readFile(join(directory, "package.json"), "utf8"))
          .version,
        expected,
      );
      const lock = JSON.parse(
        await readFile(join(directory, "package-lock.json"), "utf8"),
      );
      assert.equal(lock.version, expected);
      assert.equal(lock.packages[""].version, expected);
      const notes = extractReleaseNotes(
        await readFile(join(directory, "CHANGELOG.md"), "utf8"),
        expected,
      );
      assert.match(notes, /add routing/);
      assert.match(notes, /handle timeouts/);
      assert.match(notes, /validate commits/);
      assert.match(notes, /BREAKING CHANGES/);
      assert.match(notes, /Replace oldOption with newOption/);
      assert.doesNotMatch(notes, /already released/i);
      assert.equal(
        git("rev-parse", "HEAD"),
        before,
        "Preparation must not commit",
      );
      assert.equal(git("tag", "--list"), "v1.2.3", "Preparation must not tag");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("release notes preserve subsections while excluding older releases", () => {
  const notes = extractReleaseNotes(
    "# Changelog\n\n### [0.1.1](url) (2026-10-09)\n\n### Bug Fixes\n\n- Fix routing.\n\n## 0.1.0 — Initial development\n\n- Old entry.\n",
    "0.1.1",
  );
  assert.match(notes, /Bug Fixes/);
  assert.doesNotMatch(notes, /Old entry/);
  assert.throws(() => extractReleaseNotes("# Changelog\n", "0.1.1"));
  assert.throws(() => extractReleaseNotes("# Changelog\n", "invalid"));
});

test("commit policy accepts conventional, scoped, breaking, and release messages", () => {
  for (const message of [
    "fix(router): handle missing state",
    "feat!: change the routing contract\n\nBREAKING CHANGE: Update the old configuration.",
    "chore(release): 0.2.0",
  ]) {
    const result = spawnSync(
      process.execPath,
      [commitlintCLI, "--config", join(project, "commitlint.config.cjs")],
      { input: message, encoding: "utf8", cwd: project },
    );
    assert.equal(
      result.status,
      0,
      `${message}: ${result.stdout}${result.stderr}`,
    );
  }
});

test("commit policy rejects unstructured messages and unsupported commit types", () => {
  for (const message of [
    "Update the router",
    "banana: change the router",
    "fix:",
    "Merge branch 'topic'",
  ]) {
    const result = spawnSync(
      process.execPath,
      [commitlintCLI, "--config", join(project, "commitlint.config.cjs")],
      { input: message, encoding: "utf8", cwd: project },
    );
    assert.notEqual(result.status, 0, message);
  }
});
