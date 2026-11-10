import { constants, copyFileSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative } from "node:path";

function ensureLocalDirectory(directory) {
  try {
    return relative(directory, realpathSync(directory)) === "" && lstatSync(directory).isDirectory();
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    const parent = dirname(directory);
    if (parent === directory || !ensureLocalDirectory(parent)) return false;
    try { mkdirSync(directory); } catch (mkdirError) {
      if (mkdirError?.code !== "EEXIST") throw mkdirError;
    }
    return relative(directory, realpathSync(directory)) === "" && lstatSync(directory).isDirectory();
  }
}

// npm's cache can supply a tarball by integrity without an index entry. Copy
// only content named by the lockfile, and let npm verify it during installation.
// Installed dependencies, generated clients and npm configuration stay private.
export function seedLockedNpmCache(lockfile, sourceCache, destinationCache) {
  const packages = JSON.parse(readFileSync(lockfile, "utf8")).packages;
  const integrities = new Set(Object.values(packages ?? {}).map(pkg => pkg.integrity)
    .filter(value => typeof value === "string" && /^sha512-[A-Za-z0-9+/]{86}==$/u.test(value)));
  let copied = 0;
  for (const integrity of integrities) {
    const digest = Buffer.from(integrity.slice(7), "base64").toString("hex");
    const bucket = join("_cacache", "content-v2", "sha512", digest.slice(0, 2), digest.slice(2, 4));
    const sourceDirectory = join(sourceCache, bucket);
    const destinationDirectory = join(destinationCache, bucket);
    const name = digest.slice(4);
    try {
      if (relative(sourceDirectory, realpathSync(sourceDirectory)) !== "" ||
          !lstatSync(join(sourceDirectory, name)).isFile() || !ensureLocalDirectory(destinationDirectory)) continue;
      copyFileSync(join(sourceDirectory, name), join(destinationDirectory, name), constants.COPYFILE_EXCL);
      copied++;
    } catch (error) {
      // Cache misses and competing seeders are ordinary. npm handles misses
      // normally, and the worker never overwrites an existing cache entry.
      if (!["ENOENT", "EEXIST"].includes(error?.code)) throw error;
    }
  }
  return copied;
}
