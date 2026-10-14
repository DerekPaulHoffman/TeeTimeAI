import { describe, expect, it } from "vitest";
import { literalPublicScriptImports } from "./simulator-script-imports";

const source = "https://modules.example.test/app/main.js";
describe("literal public script imports", () => {
  it("retains exact imports, re-exports and literal dynamic imports in source order", () => {
    expect(literalPublicScriptImports(`import './first.js'; export { x } from '../shared.js';
      export * from '/all.js'; import('https://other.example.test/late.js');`, source))
      .toEqual(["https://modules.example.test/app/first.js", "https://modules.example.test/shared.js",
        "https://modules.example.test/all.js", "https://other.example.test/late.js"]);
  });
  it("never resolves packages, computed imports, private URLs, credentials or challenges", () => {
    const code = `import 'react'; import('#alias'); import('./' + 'computed.js');
      import('http://127.0.0.1/private'); import('https://user:password@example.test/file.js');
      import('https://modules.example.test/login'); import('https://cdn.example.test/captcha.js');
      import('https://cdn.example.test/lib.js?token=private');`;
    expect(literalPublicScriptImports(code, source)).toEqual([]);
  });
  it("does not evaluate code or treat ordinary strings and requests as imports", () => {
    expect(literalPublicScriptImports(`throw new Error('do not execute');
      const value='./not-an-import.js'; fetch('./api'); import('./safe.js');`, source))
      .toEqual(["https://modules.example.test/app/safe.js"]);
  });
  it("bounds parsing and distinct dependencies and skips malformed source", () => {
    expect(literalPublicScriptImports("x".repeat(1_500_001), source)).toEqual([]);
    expect(literalPublicScriptImports("import (broken", source)).toEqual([]);
    const imports = Array.from({ length: 24 }, (_, index) => `import './module-${index}.js';`).join("\n");
    expect(literalPublicScriptImports(imports, source)).toEqual(Array.from({ length: 20 }, (_, index) => `https://modules.example.test/app/module-${index}.js`));
  });
});
