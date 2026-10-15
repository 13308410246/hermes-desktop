/**
 * Installer support for the bundled (zero-config) backend.
 *
 * If `resources/hermes-bundle/` is present in the packaged app, the desktop
 * can skip downloading + compiling Hermes Agent on first launch. The bundle
 * contains:
 *   - python/                    (Windows: embeddable Python 3.12; POSIX: n/a)
 *   - site-packages/             (hermes-agent + deps, pip --target)
 *   - bin/hermes-agent(.cmd)     (CLI shim; the desktop spawns it)
 *   - version.json               (build metadata)
 *
 * At first run we copy the bundle to $HERMES_HOME/hermes-agent (a sibling of
 * the layout the old installer would have created via git clone). After that
 * the rest of the desktop code is oblivious to whether Hermes came from the
 * bundle or from a download.
 */
import {
  existsSync,
  mkdirSync,
  copyFileSync,
  cpSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { join, dirname } from "path";
import { app } from "electron";
import { HERMES_HOME, HERMES_REPO, HERMES_PYTHON } from "./installer";
import type { InstallProgress } from "../shared/update-progress";

interface BundleInfo {
  present: boolean;
  version?: string;
  hermesPackage?: string;
  pythonVersion?: string;
  sizeBytes?: number;
  sourcePath?: string;
  targetPath?: string;
}

/** Resolve the path to the bundled backend shipped inside the app. */
export function bundledBackendSourcePath(): string | null {
  if (!app?.isPackaged) return null;
  // process.resourcesPath resolves to the platform-correct location:
  //   Windows: <app>/resources
  //   macOS:   <app>/Contents/Resources
  //   Linux:   <app>/resources
  const candidate = join(process.resourcesPath, "hermes-bundle");
  return existsSync(join(candidate, "version.json")) ? candidate : null;
}

/** Synchronous check; safe to call from checkInstallStatus() hot path. */
export function hasBundledBackend(): boolean {
  return bundledBackendSourcePath() !== null;
}

function bundleMarkerPath(): string {
  return join(HERMES_HOME, ".bundle-installed");
}

function bundleIsDeployed(): boolean {
  return (
    existsSync(bundleMarkerPath()) &&
    existsSync(HERMES_PYTHON)
  );
}

/** Copy the bundle into HERMES_REPO and write a marker. Idempotent: skips if
 *  the marker is present. Emits progress events for the install UI. */
export async function setupBundledBackend(
  onProgress: (p: InstallProgress) => void,
): Promise<void> {
  if (bundleIsDeployed()) {
    onProgress({
      step: 7,
      totalSteps: 7,
      title: "后端已就绪",
      detail: "检测到内置后端，跳过解压。",
      log: "\u2705 Bundle already deployed, skipping.\n",
    });
    return;
  }

  const src = bundledBackendSourcePath();
  if (!src) {
    throw new Error(
      "setupBundledBackend called without a bundle in resources/",
    );
  }

  onProgress({
    step: 1,
    totalSteps: 7,
    title: "解压内置后端",
    detail: "首次启动：把 Python + Hermes Agent 解压到本地 ...",
    log: `\u2192 Copying bundle from ${src}\n\u2192 to ${HERMES_HOME}\n`,
  });

  mkdirSync(HERMES_HOME, { recursive: true });

  // Copy the bundle's *contents* (not the directory itself) into HERMES_REPO.
  // This gives us:
  //   $HERMES_HOME/hermes-agent/python/...
  //   $HERMES_HOME/hermes-agent/site-packages/...
  //   $HERMES_HOME/hermes-agent/bin/...
  // The rest of the codebase expects exactly that layout (see HERMES_PYTHON).
  cpSync(src, HERMES_REPO, {
    recursive: true,
    dereference: true,
    preserveTimestamps: true,
    filter: (srcPath, destPath) => {
      // Skip tcl/tk — embedded Python ships them but hermes-agent
      // doesn't need them and they add ~10 MB.
      const rel = srcPath.replace(src, "").replace(/^[/\\]/, "");
      return !(
        rel.startsWith("tcl") ||
        rel.startsWith("tkinter")
      );
    },
  });

  onProgress({
    step: 4,
    totalSteps: 7,
    title: "设置执行权限",
    detail: "为 hermes-agent 设置可执行位 ...",
    log: "\u2192 chmod +x bin/hermes-agent (POSIX only)\n",
  });

  // Re-apply executable bits on POSIX (cpSync from a zip can strip them).
  if (process.platform !== "win32") {
    const { chmodSync, readdirSync: readDir, statSync: stat } = await import(
      "fs",
    );
    const binDir = join(HERMES_REPO, "bin");
    if (existsSync(binDir)) {
      for (const f of readDir(binDir)) {
        const fp = join(binDir, f);
        const st = stat(fp);
        chmodSync(fp, st.mode | 0o111);
      }
    }
  }

  // Write the marker so subsequent launches skip this step.
  const versionJsonPath = join(HERMES_REPO, "version.json");
  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(readFileSync(versionJsonPath, "utf-8"));
  } catch {
    /* malformed version.json — non-fatal */
  }
  writeFileSync(
    bundleMarkerPath(),
    JSON.stringify(
      {
        bundleVersion: meta["bundleVersion"] ?? "unknown",
        deployedAt: new Date().toISOString(),
        hermesPackage: meta["hermesPackage"] ?? "hermes-agent",
      },
      null,
      2,
    ),
  );

  onProgress({
    step: 6,
    totalSteps: 7,
    title: "验证后端",
    detail: "运行 hermes-agent --version ...",
    log: "\u2192 Spawning hermes-agent --version to verify...\n",
  });

  // Smoke-test: invoke the bundled Python to confirm it answers.
  const { execFile } = await import("child_process");
  const ok = await new Promise<boolean>((resolve) => {
    execFile(
      HERMES_PYTHON,
      ["-m", "hermes_cli.main", "--version"],
      {
        cwd: HERMES_REPO,
        env: {
          ...process.env,
          HERMES_HOME,
          PATH: process.env.PATH ?? "",
        },
        timeout: 30_000,
        windowsHide: true,
      },
      (err, stdout) => {
        if (err) {
          onProgress({
            step: 7,
            totalSteps: 7,
            title: "后端校验失败",
            detail: `hermes-agent --version exited non-zero`,
            log: `\u274c ${err.message}\n${stdout?.toString() ?? ""}\n`,
          });
          resolve(false);
        } else {
          onProgress({
            step: 7,
            totalSteps: 7,
            title: "后端已就绪",
            detail: stdout?.toString().trim() || "OK",
            log: `\u2705 ${stdout?.toString().trim()}\n`,
          });
          resolve(true);
        }
      },
    );
  });

  if (!ok) {
    throw new Error(
      "Bundled backend verification failed. The installer will fall back to " +
        "downloading Hermes. Please report this on GitHub Issues.",
    );
  }
}

export function getBundleInfo(): BundleInfo {
  const src = bundledBackendSourcePath();
  if (!src) return { present: false };

  let versionInfo: Record<string, unknown> = {};
  try {
    versionInfo = JSON.parse(
      readFileSync(join(src, "version.json"), "utf-8"),
    );
  } catch {
    /* version.json malformed — treat as info-less bundle */
  }

  return {
    present: true,
    version: versionInfo["bundleVersion"] as string | undefined,
    hermesPackage: versionInfo["hermesPackage"] as string | undefined,
    pythonVersion: versionInfo["pythonVersion"] as string | undefined,
    sourcePath: src,
    targetPath: bundleIsDeployed() ? HERMES_REPO : undefined,
  };
}
