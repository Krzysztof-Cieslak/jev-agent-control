import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  access,
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  packRelease,
  publicationAction,
  publishedIntegrity,
  validatePackResult,
  verifyRelease,
} from "../scripts/npm-release.js";

const identity = { name: "fixture", version: "1.2.3" };
const documents = [
  "README.md",
  "CONTRIBUTING.md",
  "CHANGELOG.md",
  "LICENSE",
  "CODE_OF_CONDUCT.md",
];
const validPack = () => ({
  ...identity,
  filename: "fixture-1.2.3.tgz",
  integrity: "sha512-AAAA",
  files: ["package.json", "dist/index.js", "dist/index.d.ts", ...documents].map(
    (path) => ({ path }),
  ),
});

test("package validation requires built entrypoints and rejects private or development files", () => {
  validatePackResult(validPack(), identity);
  const missing = validPack();
  missing.files = missing.files.filter((file) => file.path !== "dist/index.js");
  assert.throws(
    () => validatePackResult(missing, identity),
    /Required package file missing/,
  );
  for (const path of [
    ".env",
    ".npmrc",
    "examples/.env",
    "src/index.ts",
    "test/live.ts",
  ]) {
    const pack = validPack();
    pack.files.push({ path });
    assert.throws(() => validatePackResult(pack, identity));
  }
  assert.throws(
    () => validatePackResult({ ...validPack(), version: "2.0.0" }, identity),
    /Unexpected package version/,
  );
  assert.throws(
    () =>
      validatePackResult(
        { ...validPack(), filename: "../fixture.tgz" },
        identity,
      ),
    /Invalid archive filename/,
  );
});

test("the packed artifact is bound to the manifest, contents, and source commit", async () => {
  const temporary =
    process.env.TMPDIR ??
    (await access("/tmp/opencode").then(
      () => "/tmp/opencode",
      () => tmpdir(),
    ));
  const root = await mkdtemp(join(temporary, "jev-package-test-"));
  const project = join(root, "project");
  const output = join(root, "output");
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-C",
        project,
        "-c",
        "user.name=Package Test",
        "-c",
        "user.email=package@example.invalid",
        ...args,
      ],
      { encoding: "utf8" },
    ).trim();
  try {
    await mkdir(join(project, "dist"), { recursive: true });
    await writeFile(
      join(project, "package.json"),
      JSON.stringify({
        ...identity,
        files: ["dist", ...documents],
        type: "module",
        exports: {
          ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
        },
      }),
    );
    await writeFile(join(project, "dist/index.js"), "export default {};\n");
    await writeFile(
      join(project, "dist/index.d.ts"),
      "declare const plugin: {}; export default plugin;\n",
    );
    for (const document of documents)
      await writeFile(join(project, document), `# ${document}\n`);
    await writeFile(join(project, ".gitignore"), ".env\n");
    git("init", "-b", "main");
    git("add", ".");
    git("commit", "-m", "feat: create fixture");
    await writeFile(join(project, ".env"), "SECRET=not-for-publication\n");

    const artifact = await packRelease(output, project);
    assert.deepEqual(await verifyRelease(output, project), artifact);
    const files = execFileSync(
      "tar",
      ["-tzf", join(output, artifact.filename)],
      { encoding: "utf8" },
    );
    assert.ok(!files.includes(".env"));

    await appendFile(join(project, "README.md"), "Uncommitted change\n");
    await assert.rejects(
      packRelease(output, project),
      /working tree must be clean/,
    );
    await writeFile(join(project, "README.md"), "# README.md\n");

    git("commit", "--allow-empty", "-m", "docs: advance checkout");
    await assert.rejects(verifyRelease(output, project), /different commit/);
    const metadata = { ...artifact, commit: git("rev-parse", "HEAD") };
    await writeFile(join(output, "release.json"), JSON.stringify(metadata));
    await appendFile(join(output, artifact.filename), "modified archive");
    await assert.rejects(
      verifyRelease(output, project),
      /Archive integrity mismatch/,
    );
    assert.equal(
      JSON.parse(await readFile(join(project, "package.json"), "utf8")).version,
      identity.version,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("registry lookups distinguish missing versions from errors and validate identity", async () => {
  assert.equal(
    await publishedIntegrity(
      identity,
      async () => new Response(null, { status: 404 }),
    ),
    undefined,
  );
  const result = await publishedIntegrity(identity, async (url) => {
    assert.equal(String(url), "https://registry.npmjs.org/fixture/1.2.3");
    return Response.json({ ...identity, dist: { integrity: "sha512-AAAA" } });
  });
  assert.equal(result, "sha512-AAAA");
  for (const status of [401, 403, 429, 500]) {
    await assert.rejects(
      publishedIntegrity(identity, async () => new Response(null, { status })),
      /registry lookup failed/,
    );
  }
  await assert.rejects(
    publishedIntegrity(identity, async () =>
      Response.json({
        ...identity,
        name: "other",
        dist: { integrity: "sha512-AAAA" },
      }),
    ),
    /unexpected package/,
  );
  await assert.rejects(
    publishedIntegrity(identity, async () => Response.json(identity)),
    /no integrity metadata/,
  );
});

test("publication can be retried only when an existing version has identical contents", () => {
  assert.equal(publicationAction("sha512-AAAA", undefined), "publish");
  assert.equal(publicationAction("sha512-AAAA", "sha512-AAAA"), "skip");
  assert.throws(
    () => publicationAction("sha512-AAAA", "sha512-BBBB"),
    /already exists with different contents/,
  );
});
