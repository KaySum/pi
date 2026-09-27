#!/usr/bin/env node
import { access, readFile, readdir } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const settingsPath = resolve(root, "settings.json");
const npmRoot = resolve(root, "npm");
const nodeModules = resolve(npmRoot, "node_modules");
const gitRoot = resolve(root, "git");
const dryRun = process.argv.includes("--dry-run");

function fail(message) {
  console.error(`sync: ${message}`);
  process.exit(1);
}

function runPi(args) {
  const result = spawnSync("pi", args, { cwd: root, stdio: "inherit" });
  if (result.error) fail(`could not run pi: ${result.error.message}`);
  if (result.status !== 0) fail(`pi ${args.join(" ")} failed with exit code ${result.status}`);
}

function sourceOf(entry) {
  const source = typeof entry === "string" ? entry : entry?.source;
  if (typeof source !== "string" || source.length === 0) {
    fail(`invalid package entry in settings.json: ${JSON.stringify(entry)}`);
  }
  return source;
}

function npmName(source) {
  if (!source.startsWith("npm:")) return undefined;
  const spec = source.slice(4);
  const slash = spec.startsWith("@") ? spec.indexOf("/", 1) : -1;
  if (spec.startsWith("@") && slash < 0) fail(`invalid npm package source: ${source}`);
  const versionAt = spec.indexOf("@", slash >= 0 ? slash + 1 : 0);
  return versionAt < 0 ? spec : spec.slice(0, versionAt);
}

function packageKey(source) {
  const name = npmName(source);
  if (name) return `npm:${name}`;
  if (source.startsWith("git:")) return `git:${source.slice(4).split("@")[0].replace(/\\.git$/, "")}`;
  return source;
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function discoverNpmPackages() {
  const manifestPath = resolve(npmRoot, "package.json");
  if (!(await pathExists(manifestPath))) return [];
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const dependencies = manifest.dependencies ?? {};
  const installed = [];
  for (const name of Object.keys(dependencies)) {
    const packagePath = resolve(nodeModules, name, "package.json");
    if (await pathExists(packagePath)) installed.push(`npm:${name}`);
  }
  return installed;
}

async function discoverGitPackages() {
  if (!(await pathExists(gitRoot))) return [];
  const found = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const path = resolve(directory, entry.name);
      if (entry.name === ".git") continue;
      if (await pathExists(resolve(path, ".git"))) {
        const suffix = relative(gitRoot, path).split(sep).join("/");
        found.push(`git:${suffix}`);
        continue;
      }
      if (entry.isDirectory()) await walk(path);
    }
  }
  await walk(gitRoot);
  return found;
}

const settings = JSON.parse(await readFile(settingsPath, "utf8"));
if (!Array.isArray(settings.packages)) fail("settings.json must contain a packages array");
const desired = [...new Set(settings.packages.map(sourceOf))];
const desiredKeys = new Set(desired.map(packageKey));
const installed = [...new Set([...(await discoverNpmPackages()), ...(await discoverGitPackages())])];
const installedKeys = new Set(installed.map(packageKey));

const toRemove = installed.filter((source) => !desiredKeys.has(packageKey(source)));
const toInstall = desired.filter((source) => !installedKeys.has(packageKey(source)));
console.log(`Package sync from ${settingsPath}`);
console.log(`  Uninstall: ${toRemove.length ? toRemove.join(", ") : "(none)"}`);
console.log(`  Install:   ${toInstall.length ? toInstall.join(", ") : "(none)"}`);
if (dryRun) {
  console.log("Dry run; no Pi commands or files changed.");
  process.exit(0);
}

for (const source of toRemove) runPi(["uninstall", source]);
for (const source of toInstall) runPi(["install", source]);
console.log("Pi packages now match settings.json.");
