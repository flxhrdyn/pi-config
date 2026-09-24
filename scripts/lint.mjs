import * as fs from "node:fs";
import * as path from "node:path";

const EXTENSIONS_DIR = path.resolve("extensions");
const TESTS_DIR = path.resolve("tests");

const MOJIBAKE_PATTERNS = [/Ãƒ/, /Ã‚/, /Ã¢/, /â€/, /â‚¬/];
const HARDCODED_SECRETS = [/sk-[a-zA-Z0-9_-]{20,}/];
const HARDCODED_INTERNAL_PATHS = [/install[/\\]releases[/\\]/];

let errors = 0;

function checkFile(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const rel = path.relative(process.cwd(), filePath);

  for (let i = 0; i < content.split("\n").length; i++) {
    const line = content.split("\n")[i];
    const lineNum = i + 1;

    for (const pat of MOJIBAKE_PATTERNS) {
      if (pat.test(line)) {
        console.error(`[LINT] ${rel}:${lineNum} Mojibake detected: ${line.trim()}`);
        errors++;
      }
    }

    for (const pat of HARDCODED_SECRETS) {
      if (pat.test(line)) {
        console.error(`[LINT] ${rel}:${lineNum} Hardcoded secret detected!`);
        errors++;
      }
    }

    for (const pat of HARDCODED_INTERNAL_PATHS) {
      if (pat.test(line)) {
        console.error(`[LINT] ${rel}:${lineNum} Hardcoded internal Pi release path detected: ${line.trim()}`);
        errors++;
      }
    }
  }
}

function scanDir(dir) {
  if (!fs.existsSync(dir)) return;
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory() && item.name !== "node_modules") {
      scanDir(full);
    } else if (item.isFile() && (item.name.endsWith(".ts") || item.name.endsWith(".js") || item.name.endsWith(".mjs"))) {
      checkFile(full);
    }
  }
}

scanDir(EXTENSIONS_DIR);
scanDir(TESTS_DIR);

if (errors > 0) {
  console.error(`Lint failed with ${errors} issue(s).`);
  process.exit(1);
} else {
  console.log("Lint check passed: no mojibake, no hardcoded secrets, no internal release paths.");
}
