import { execFileSync } from "node:child_process";

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8", shell: process.platform === "win32" }).trim();
}

let failed = false;
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 22) {
  console.error(`node ${process.versions.node} is too old (need >= 22)`);
  failed = true;
}

let npm = "?";
try {
  npm = run("npm", ["--version"]);
} catch {
  failed = true;
}
if (!(Number(npm.split(".")[0]) >= 9)) {
  console.error(`npm ${npm} is too old (need >= 9)`);
  failed = true;
}

let git = "?";
try {
  git = run("git", ["--version"]).replace(/^git version\s+/, "");
} catch {
  console.error("git --version failed");
  failed = true;
}

console.log(`node v${process.versions.node} npm ${npm} git ${git}`);
process.exit(failed ? 1 : 0);
