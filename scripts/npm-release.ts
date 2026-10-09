import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const REGISTRY = "https://registry.npmjs.org";

export interface PackageIdentity {
  name: string;
  version: string;
}

export interface ReleasePackage extends PackageIdentity {
  filename: string;
  integrity: string;
  commit: string;
}

interface PackResult extends PackageIdentity {
  filename: string;
  integrity: string;
  files: { path: string }[];
}

const documents = new Set([
  "package.json",
  "README.md",
  "CONTRIBUTING.md",
  "CHANGELOG.md",
  "LICENSE",
  "CODE_OF_CONDUCT.md",
]);

export function validatePackResult(
  pack: PackResult,
  expected: PackageIdentity,
): void {
  assert.equal(pack.name, expected.name, "Unexpected package name");
  assert.equal(pack.version, expected.version, "Unexpected package version");
  assert.match(
    pack.version,
    /^\d+\.\d+\.\d+$/,
    "Only stable releases are supported",
  );
  assert.equal(
    basename(pack.filename),
    pack.filename,
    "Invalid archive filename",
  );
  assert.ok(pack.filename.endsWith(".tgz"), "Expected an npm tarball");
  assert.match(
    pack.integrity,
    /^sha512-[A-Za-z0-9+/]+={0,2}$/,
    "Missing SHA-512 integrity",
  );
  for (const { path } of pack.files) {
    assert.ok(
      !path.split("/").some((part) => part.startsWith(".")),
      `Hidden file in package: ${path}`,
    );
    assert.ok(
      documents.has(path) ||
        path.startsWith("dist/") ||
        path.startsWith("examples/"),
      `Unexpected package file: ${path}`,
    );
  }
  for (const path of [...documents, "dist/index.js", "dist/index.d.ts"]) {
    assert.ok(
      pack.files.some((file) => file.path === path),
      `Required package file missing: ${path}`,
    );
  }
}

function integrity(contents: Buffer): string {
  return `sha512-${createHash("sha512").update(contents).digest("base64")}`;
}

export async function packRelease(
  directory: string,
  project = process.cwd(),
): Promise<ReleasePackage> {
  const status = execFileSync("git", ["status", "--porcelain"], {
    cwd: project,
    encoding: "utf8",
  });
  assert.equal(
    status.trim(),
    "",
    "The working tree must be clean before packing a release",
  );
  await mkdir(directory, { recursive: true });
  const manifest: PackageIdentity = JSON.parse(
    await readFile(join(project, "package.json"), "utf8"),
  );
  const packed: PackResult[] = JSON.parse(
    execFileSync(
      "npm",
      [
        "pack",
        "--json",
        "--ignore-scripts",
        "--pack-destination",
        resolve(directory),
      ],
      { cwd: project, encoding: "utf8" },
    ),
  );
  assert.equal(packed.length, 1, "Expected exactly one package");
  const pack = packed[0]!;
  validatePackResult(pack, manifest);
  assert.equal(
    integrity(await readFile(join(directory, pack.filename))),
    pack.integrity,
    "Archive integrity mismatch",
  );
  const artifact: ReleasePackage = {
    name: pack.name,
    version: pack.version,
    filename: pack.filename,
    integrity: pack.integrity,
    commit: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: project,
      encoding: "utf8",
    }).trim(),
  };
  await writeFile(
    join(directory, "release.json"),
    `${JSON.stringify(artifact, null, 2)}\n`,
  );
  return artifact;
}

export async function verifyRelease(
  directory: string,
  project = process.cwd(),
): Promise<ReleasePackage> {
  const artifact: ReleasePackage = JSON.parse(
    await readFile(join(directory, "release.json"), "utf8"),
  );
  const manifest: PackageIdentity = JSON.parse(
    await readFile(join(project, "package.json"), "utf8"),
  );
  assert.equal(
    artifact.name,
    manifest.name,
    "Archive name does not match checkout",
  );
  assert.equal(
    artifact.version,
    manifest.version,
    "Archive version does not match checkout",
  );
  assert.equal(
    basename(artifact.filename),
    artifact.filename,
    "Invalid archive filename",
  );
  assert.ok(artifact.filename.endsWith(".tgz"), "Expected an npm tarball");
  const archive = join(directory, artifact.filename);
  assert.equal(
    integrity(await readFile(archive)),
    artifact.integrity,
    "Archive integrity mismatch",
  );
  const packed: PackageIdentity = JSON.parse(
    execFileSync("tar", ["-xOzf", archive, "package/package.json"], {
      encoding: "utf8",
    }),
  );
  assert.equal(
    packed.name,
    manifest.name,
    "Packed manifest has an unexpected name",
  );
  assert.equal(
    packed.version,
    manifest.version,
    "Packed manifest has an unexpected version",
  );
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: project,
    encoding: "utf8",
  }).trim();
  assert.equal(
    artifact.commit,
    commit,
    "Archive was built from a different commit",
  );
  return artifact;
}

export async function publishedIntegrity(
  identity: PackageIdentity,
  fetcher: typeof fetch = fetch,
): Promise<string | undefined> {
  const response = await fetcher(
    `${REGISTRY}/${encodeURIComponent(identity.name)}/${encodeURIComponent(identity.version)}`,
    { signal: AbortSignal.timeout(15000) },
  );
  if (response.status === 404) return undefined;
  assert.ok(response.ok, `npm registry lookup failed (${response.status})`);
  const result = (await response.json()) as {
    name?: string;
    version?: string;
    dist?: { integrity?: string };
  };
  assert.equal(
    result.name,
    identity.name,
    "Registry returned an unexpected package",
  );
  assert.equal(
    result.version,
    identity.version,
    "Registry returned an unexpected version",
  );
  assert.equal(
    typeof result.dist?.integrity,
    "string",
    "Published package has no integrity metadata",
  );
  return result.dist!.integrity!;
}

export function publicationAction(
  expected: string,
  published: string | undefined,
): "publish" | "skip" {
  if (published === undefined) return "publish";
  assert.equal(
    published,
    expected,
    "This npm version already exists with different contents",
  );
  return "skip";
}

async function main(): Promise<void> {
  const [, , command, target] = process.argv;
  assert.ok(
    target && ["pack", "preview", "publish"].includes(command ?? ""),
    "Usage: npm-release.ts <pack|preview|publish> <artifact-directory>",
  );
  const directory = resolve(target);
  if (command === "pack") {
    const artifact = await packRelease(directory);
    console.log(
      `Packed ${artifact.name}@${artifact.version}: ${artifact.filename}`,
    );
    return;
  }
  const artifact = await verifyRelease(directory);
  if (command === "publish") {
    const published = await publishedIntegrity(artifact);
    if (publicationAction(artifact.integrity, published) === "skip") {
      console.log(
        `${artifact.name}@${artifact.version} is already published with matching integrity.`,
      );
      return;
    }
  }
  execFileSync(
    "npm",
    [
      "publish",
      join(directory, artifact.filename),
      "--ignore-scripts",
      "--access",
      "public",
      "--tag",
      "latest",
      "--registry",
      REGISTRY,
      ...(command === "preview" ? ["--dry-run"] : []),
    ],
    { stdio: "inherit" },
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await main();
}
