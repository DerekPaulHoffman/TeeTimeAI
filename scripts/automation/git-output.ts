export function normalizeGitCommandOutput(output: string) {
  return output.trimEnd();
}

export function parseGitNulPaths(output: string) {
  return [
    ...new Set(
      output
        .split("\0")
        .filter((path) => path.length > 0)
        .map((path) => path.replaceAll("\\", "/"))
    )
  ];
}

export function parseGitPorcelainV1ZPaths(output: string) {
  const records = output.split("\0");
  const paths: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) {
      continue;
    }
    if (record.length < 4 || record[2] !== " ") {
      throw new Error("Git returned an invalid porcelain v1 record.");
    }
    const status = record.slice(0, 2);
    paths.push(record.slice(3));
    if (status.includes("R") || status.includes("C")) {
      const sourcePath = records[index + 1];
      if (!sourcePath) {
        throw new Error("Git returned an incomplete rename/copy record.");
      }
      paths.push(sourcePath);
      index += 1;
    }
  }
  return [
    ...new Set(paths.map((path) => path.replaceAll("\\", "/")))
  ];
}
