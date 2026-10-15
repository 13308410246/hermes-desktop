#!/usr/bin/env node
/**
 * Bundle Hermes Agent + Python into resources/hermes-bundle/ for inclusion
 * in the desktop installer. Run by CI before electron-builder.
 *
 * Produces:
 *   resources/hermes-bundle/
 *     ├── python/                 (Python 3.12 embeddable on win, system on POSIX)
 *     ├── site-packages/          (hermes-agent + all transitive deps)
 *     ├── bin/
 *     │   └── hermes-agent(.cmd) (CLI shim, the desktop calls this)
 *     └── version.json            (build metadata for the renderer to show)
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, copyFileSync, writeFileSync, readFileSync, statSync, readdirSync, createWriteStream } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import https from "node:https";
import { pipeline } from "node:stream/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const OUT = join(ROOT, "resources", "hermes-bundle");
const PY_VERSION = "3.12.7";

// CLI args
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "true"];
  })
);
const PLATFORM = args.platform ?? process.platform;   // win32 | darwin | linux
const ARCH = args.arch ?? process.arch;            // x64 | arm64
const HERMES_PKG = args.pkg ?? "hermes-agent";

const IS_WINDOWS = PLATFORM === "win32";
const IS_MAC = PLATFORM === "darwin";

const log = (m) => console.log(`[bundle] ${m}`);
const die = (m) => { console.error(`[bundle] FATAL: ${m}`); process.exit(1); };

function fetchToFile(url, dest) {
  return new Promise((resolveP, rejectP) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchToFile(res.headers.location, dest).then(resolveP, rejectP);
      }
      if (res.statusCode !== 200) return rejectP(new Error(`HTTP ${res.statusCode} for ${url}`));
      pipeline(res, createWriteStream(dest)).then(resolveP, rejectP);
    }).on("error", rejectP);
  });
}

async function sha256File(path) {
  const buf = await import("node:fs/promises").then((m) => m.readFile(path));
  return createHash("sha256").update(buf).digest("hex");
}

async function downloadPython() {
  const pyDir = join(OUT, "python");
  if (existsSync(pyDir)) {
    log(`Python already in ${pyDir} — skipping download`);
    return pyDir;
  }
  mkdirSync(pyDir, { recursive: true });

  if (IS_WINDOWS) {
    // Use the python.org embeddable zip. URL is deterministic for a given version.
    const archSuffix = ARCH === "arm64" ? "arm64" : "amd64";
    const url = `https://www.python.org/ftp/python/${PY_VERSION}/python-${PY_VERSION}-embed-${archSuffix}.zip`;
    const zipPath = join(OUT, "_python.zip");
    log(`Downloading Python ${PY_VERSION} embeddable from python.org (${archSuffix})...`);
    await fetchToFile(url, zipPath);
    log(`Extracting Python...`);
    execFileSync("powershell", [
      "-NoProfile", "-Command",
      `Expand-Archive -LiteralPath "${zipPath}" -DestinationPath "${pyDir}" -Force`
    ], { stdio: "inherit" });
    rmSync(zipPath);

    // Enable site-packages in embedded distribution.
    // python312._pth has "#import site" commented out by default.
    const majorMinor = PY_VERSION.slice(0, 4).replace(".", "");
    const pthFile = join(pyDir, `python${majorMinor}._pth`);
    if (existsSync(pthFile)) {
      let content = readFileSync(pthFile, "utf-8");
      content = content.replace(/^#import site/m, "import site");
      if (!content.includes("..\\site-packages") && !content.includes("../site-packages")) {
        content += "\n..\\site-packages\n";
      }
      writeFileSync(pthFile, content, "utf-8");
      log(`Patched ${pthFile} to enable site-packages`);
    }
  } else {
    // On macOS/Linux: assume host Python ≥ 3.11 with pip is available.
    // Bundle just site-packages, not the interpreter — saves ~80 MB.
    const pyCmd = IS_MAC ? "python3" : "python3";
    const result = spawnSync(pyCmd, ["--version"], { encoding: "utf-8" });
    if (result.status !== 0) die("No system python3 found on POSIX build host");
    log(`Host Python: ${result.stdout.trim()}`);
  }
  return pyDir;
}

function installHermesPackage(sitePackagesDir) {
  log(`Installing ${HERMES_PKG} and deps into ${sitePackagesDir}...`);
  mkdirSync(sitePackagesDir, { recursive: true });
  const pipArgs = [
    "pip", "install",
    "--target", sitePackagesDir,
    "--upgrade",
    "--no-cache-dir",
    "--disable-pip-version-check",
    HERMES_PKG,
  ];
  const py = IS_WINDOWS ? "python" : "python3";
  execFileSync(py, ["-m", ...pipArgs], { stdio: "inherit" });
}

function writeHermesShim(binDir, pythonDir) {
  if (IS_WINDOWS) {
    const pyExe = join(pythonDir, "python.exe");
    const shim = `@echo off\r\n"${pyExe}" -m hermes_cli.main %*\r\n`;
    writeFileSync(join(binDir, "hermes-agent.cmd"), shim);
    log(`Wrote shim: ${binDir}\\hermes-agent.cmd`);
  } else {
    const shim = `#!/usr/bin/env python3
# Auto-generated wrapper for the bundled Hermes CLI.
import sys
from pathlib import Path
HERE = Path(__file__).resolve().parent
SITE_PACKAGES = HERE.parent / "site-packages"
sys.path.insert(0, str(SITE_PACKAGES))
from hermes_cli.main import main
sys.exit(main())
`;
    const shimPath = join(binDir, "hermes-agent");
    writeFileSync(shimPath, shim);
    const { chmodSync } = await import("fs");
    chmodSync(shimPath, statSync(shimPath).mode | 0o111);
    log(`Wrote shim: ${shimPath}`);
  }
}

async function writeBundleMetadata() {
  const meta = {
    bundleVersion: "1.0.0",
    hermesPackage: HERMES_PKG,
    pythonVersion: PY_VERSION,
    platform: PLATFORM,
    arch: ARCH,
    buildTimestamp: new Date().toISOString(),
  };
  writeFileSync(join(OUT, "version.json"), JSON.stringify(meta, null, 2));
  log(`Wrote version.json`);
}

function computeBundleSizeMb() {
  let total = 0;
  function walk(p) {
    for (const e of readdirSync(p, { withFileTypes: true })) {
      const fp = join(p, e.name);
      if (e.isDirectory()) walk(fp);
      else total += statSync(fp).size;
    }
  }
  walk(OUT);
  return (total / 1024 / 1024).toFixed(1);
}

async function main() {
  log(`Bundling for ${PLATFORM}/${ARCH}, output: ${OUT}`);
  if (existsSync(OUT)) {
    log("Cleaning previous bundle");
    rmSync(OUT, { recursive: true, force: true });
  }
  mkdirSync(OUT, { recursive: true });

  const pyDir = await downloadPython();
  const sitePackages = join(OUT, "site-packages");
  installHermesPackage(sitePackages);

  const binDir = join(OUT, "bin");
  mkdirSync(binDir, { recursive: true });
  writeHermesShim(binDir, pyDir);

  // On POSIX, also copy console scripts pip --target put in site-packages/bin/
  if (!IS_WINDOWS) {
    const pipBinDir = join(sitePackages, "bin");
    if (existsSync(pipBinDir)) {
      for (const f of readdirSync(pipBinDir)) {
        const src = join(pipBinDir, f);
        const dest = join(binDir, f);
        copyFileSync(src, dest);
        const mode = statSync(src).mode | 0o111;
        const content = readFileSync(src);
        writeFileSync(dest, content, { mode });
        log(`Linked pip script: ${dest}`);
      }
    }
  }

  await writeBundleMetadata();

  const sizeMb = computeBundleSizeMb();
  log(`Bundle complete: ${sizeMb} MB at ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
