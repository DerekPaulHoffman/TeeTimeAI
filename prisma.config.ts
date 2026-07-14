import { defineConfig } from "prisma/config";

import { resolvePrismaCliDatabaseUrl } from "./src/lib/database-url";

const isGenerateCommand = process.argv.includes("generate");

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations"
  },
  datasource: {
    url: resolvePrismaCliDatabaseUrl(process.env, {
      allowVercelGeneratePlaceholder: isGenerateCommand
    })
  }
});
