import { getConnectionConfig, type ConnectionConfig } from "./config";
import { normaliseRemoteUrl } from "./hermes";
import { remoteDashboardRequestJson } from "./remote-api";

type GatewayAction = "start" | "stop" | "restart";
type GatewayActionResult = { success: boolean; error?: string };
type GatewayStatus = { gateway_running: boolean; gateway_pid?: number | null };
type ActionStatus = { pid: number; running: boolean; exit_code: number | null };

// Shutdown can drain active work for ~180 seconds. Timeout reports unconfirmed
// completion; it does not cancel an accepted server command.
const COMPLETION_TIMEOUT_MS = 240_000;
const POLL_INTERVAL_MS = 1000;
const pendingActions = new Set<string>();

function profileQuery(path: string, profile?: string): string {
  return `${path}?profile=${encodeURIComponent(profile || "default")}`;
}

async function gatewayJson<T>(
  connection: ConnectionConfig,
  path: string,
  method: "GET" | "POST" = "GET",
  timeoutMs = 15_000,
): Promise<T> {
  const anonymousRequest = async (): Promise<T> => {
    const response = await fetch(
      `${normaliseRemoteUrl(connection.remoteUrl)}${path}`,
      {
        method,
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    const data = await response.json();
    if (!response.ok)
      throw new Error(data.error || data.detail || `HTTP ${response.status}`);
    return data as T;
  };
  if (connection.remoteAuthMode === "token" && !connection.apiKey?.trim()) {
    return anonymousRequest();
  }
  try {
    return await remoteDashboardRequestJson<T>(connection, path, {
      method,
      timeoutMs,
    });
  } catch (error) {
    // Only a resolved keyless token boundary permits anonymous compatibility.
    // OAuth login/probe errors must never become anonymous mutations.
    if (
      !connection.apiKey?.trim() &&
      connection.remoteAuthMode !== "oauth" &&
      error instanceof Error &&
      error.message === "Remote Hermes dashboard token is not configured."
    ) {
      return anonymousRequest();
    }
    throw error;
  }
}

async function readGatewayStatus(
  connection: ConnectionConfig,
  profile?: string,
  timeoutMs?: number,
): Promise<GatewayStatus> {
  const status = await gatewayJson<GatewayStatus>(
    connection,
    profileQuery("/api/status", profile),
    "GET",
    timeoutMs,
  );
  if (typeof status?.gateway_running !== "boolean") {
    throw new Error("Remote gateway status did not include gateway_running.");
  }
  return status;
}

export async function remoteGatewayStatus(profile?: string): Promise<boolean> {
  try {
    return (await readGatewayStatus({ ...getConnectionConfig() }, profile))
      .gateway_running;
  } catch {
    return false;
  }
}

// @lat: [[main-process#Main Process#Remote Gateway management]]
async function spawnGatewayAction(
  action: GatewayAction,
  profile?: string,
): Promise<{ success: boolean; error?: string }> {
  const connection = { ...getConnectionConfig() };
  const key = `${normaliseRemoteUrl(connection.remoteUrl)}\n${profile || "default"}`;
  if (pendingActions.has(key)) {
    return {
      success: false,
      error: "A gateway command is already pending for this remote profile.",
    };
  }
  pendingActions.add(key);
  try {
    const before =
      action === "restart"
        ? await readGatewayStatus(connection, profile)
        : undefined;
    const name = `gateway-${action}`;
    const result = await gatewayJson<{
      ok?: boolean;
      pid?: number;
      name?: string;
    }>(connection, profileQuery(`/api/gateway/${action}`, profile), "POST");
    if (
      !result?.ok ||
      result.name !== name ||
      !Number.isInteger(result.pid) ||
      (result.pid ?? 0) <= 0
    ) {
      throw new Error(
        `Remote gateway ${action} did not return a trackable action.`,
      );
    }
    const deadline = Date.now() + COMPLETION_TIMEOUT_MS;
    let observedStopped = before?.gateway_running === false;
    while (Date.now() < deadline) {
      const timeoutMs = Math.min(15_000, deadline - Date.now());
      const command = await gatewayJson<ActionStatus>(
        connection,
        profileQuery(`/api/actions/${name}/status`, profile),
        "GET",
        timeoutMs,
      );
      if (command?.pid !== result.pid) {
        throw new Error(
          `Remote gateway ${action} action was replaced; completion cannot be confirmed.`,
        );
      }
      if (
        typeof command.running !== "boolean" ||
        (!command.running && !Number.isInteger(command.exit_code))
      ) {
        throw new Error(
          `Remote gateway ${action} did not return a completed action result.`,
        );
      }
      if (!command.running && command.exit_code !== 0) {
        throw new Error(
          `Remote gateway ${action} failed (exit ${command.exit_code}).`,
        );
      }
      const status = await readGatewayStatus(
        connection,
        profile,
        Math.max(1, Math.min(15_000, deadline - Date.now())),
      );
      if (!status.gateway_running) observedStopped = true;
      const expectedState =
        action === "stop" ? !status.gateway_running : status.gateway_running;
      const restarted =
        action !== "restart" ||
        observedStopped ||
        (typeof before?.gateway_pid === "number" &&
          typeof status.gateway_pid === "number" &&
          before.gateway_pid !== status.gateway_pid);
      if (!command.running && expectedState && restarted)
        return { success: true };
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())),
        ),
      );
    }
    throw new Error(
      `Remote gateway ${action} completion could not be confirmed. The server may still be processing the command.`,
    );
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    pendingActions.delete(key);
  }
}

export const remoteStartGateway = (
  profile?: string,
): Promise<GatewayActionResult> => spawnGatewayAction("start", profile);
export const remoteStopGateway = (
  profile?: string,
): Promise<GatewayActionResult> => spawnGatewayAction("stop", profile);
export const remoteRestartGateway = (
  profile?: string,
): Promise<GatewayActionResult> => spawnGatewayAction("restart", profile);
