import { validateRecipeDocument } from "../../src/lib/course-discovery/recipe-validation";

async function main() {
  if (process.argv.length !== 2) throw new Error("INVALID_ARGUMENTS");
  let source = "";
  for await (const chunk of process.stdin) {
    source += chunk;
    if (Buffer.byteLength(source, "utf8") > 131_072) throw new Error("REQUEST_TOO_LARGE");
  }
  process.stdout.write(`${JSON.stringify(validateRecipeDocument(source))}\n`);
}

void main().catch(error => {
  process.stderr.write(error instanceof Error && error.message === "REQUEST_TOO_LARGE"
    ? "REQUEST_TOO_LARGE\n" : "RECIPE_VALIDATION_FAILED\n");
  process.exitCode = 1;
});
