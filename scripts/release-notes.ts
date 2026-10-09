import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Patch releases use ###, while major/minor releases use ##. */
export function extractReleaseNotes(
  changelog: string,
  version: string,
): string {
  if (!/^\d+\.\d+\.\d+$/.test(version))
    throw new Error("Expected a stable semantic version");
  const lines = changelog.split(/\r?\n/);
  const releaseHeading = /^#{2,3} \[?v?(\d+\.\d+\.\d+)(?=[\]\s(]|$)/;
  const start = lines.findIndex(
    (line) => releaseHeading.exec(line)?.[1] === version,
  );
  if (start < 0) throw new Error(`No changelog entry for ${version}`);
  const next = lines.findIndex(
    (line, index) => index > start && releaseHeading.test(line),
  );
  return `${lines
    .slice(start, next < 0 ? undefined : next)
    .join("\n")
    .trim()}\n`;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [, , version, output] = process.argv;
  if (!version || !output)
    throw new Error("Usage: release-notes.ts <version> <output-file>");
  const notes = extractReleaseNotes(
    await readFile("CHANGELOG.md", "utf8"),
    version,
  );
  await writeFile(output, notes);
}
