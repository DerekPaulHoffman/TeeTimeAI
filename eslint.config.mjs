import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = [
  {
    ignores: [
      ".next/**",
      ".venv/**",
      "coverage/**",
      "legacy/**",
      "node_modules/**",
      "out/**"
    ]
  },
  ...nextVitals,
  ...nextTs
];

export default eslintConfig;
