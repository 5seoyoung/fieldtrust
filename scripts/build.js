#!/usr/bin/env node
// Assembles src/ into the single-file index.html (see docs/DECISIONS.md D-003).
// Each `INJECT:<file>` marker in the template is replaced by that file's
// contents. No bundler, no transform - the output is the input, inlined.
//
//   node scripts/build.js          write index.html
//   node scripts/build.js --check  exit 1 if index.html is stale (used in CI)

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "src");
const OUT = path.join(ROOT, "index.html");

function assemble() {
  const template = fs.readFileSync(path.join(SRC, "index.template.html"), "utf8");
  return template.replace(/^[ \t]*(?:\/\*|\/\/) INJECT:([\w.]+)(?: \*\/)?[ \t]*$/gm, (_, file) =>
    fs.readFileSync(path.join(SRC, file), "utf8").replace(/\n$/, "")
  );
}

const built = assemble();

if (process.argv.includes("--check")) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";
  if (current !== built) {
    console.error("index.html is stale. Run `npm run build` and commit the result.");
    process.exit(1);
  }
  console.log("index.html is up to date with src/");
} else {
  fs.writeFileSync(OUT, built);
  console.log(`built index.html (${built.length} bytes)`);
}
