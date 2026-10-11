import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A stable `t`, like the real hook: a fresh function per render would recreate
// `loadConfig` and re-run its effect forever once a request fails.
const stableT = (key: string): string => key;
vi.mock("../../components/useI18n", () => ({
  useI18n: () => ({ t: stableT }),
}));
vi.mock("../../components/common/BrandLogo", () => ({
  default: () => <div data-testid="brand-logo" />,
}));

import Gateway from "./Gateway";

function installApi(overrides: Record<string, unknown> = {}): void {
  Object.defineProperty(window, "hermesAPI", {
    configurable: true,
    value: {
      getEnv: vi.fn().mockResolvedValue({}),
      getApiServerKeyStatus: vi.fn().mockResolvedValue({ hasKey: true }),
      gatewayStatus: vi.fn().mockResolvedValue(true),
      gatewayCommandPending: vi.fn().mockResolvedValue(false),
      getPlatformEnabled: vi.fn().mockResolvedValue({}),
      restartGateway: vi.fn().mockResolvedValue(true),
      startGateway: vi
        .fn()
        .mockResolvedValue({ success: true, running: false }),
      stopGateway: vi.fn().mockResolvedValue(true),
      getMessagingPlatforms: vi
        .fn()
        .mockResolvedValue({ platforms: [], message: null }),
      openExternal: vi.fn(),
      onConnectionConfigChanged: vi.fn().mockReturnValue(() => {}),
      ...overrides,
    },
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("Gateway screen with a selected profile / failing platform list", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("keeps the gateway status and controls when the platform list fails to load", async () => {
    installApi({
      getMessagingPlatforms: vi
        .fn()
        .mockRejectedValue(new Error("Unauthorized")),
    });
    render(<Gateway profile="work" remoteMode />);
    await settle();
    expect(screen.getByText("gateway.running")).toBeTruthy();
    expect(screen.getByText("gateway.restart")).toBeTruthy();
    expect(screen.getByText("Unauthorized")).toBeTruthy();
    expect(window.hermesAPI.gatewayStatus).toHaveBeenCalledWith("work");
  });

  it("passes the selected profile to status, start and stop", async () => {
    installApi({ gatewayStatus: vi.fn().mockResolvedValue(false) });
    render(<Gateway profile="work" />);
    await settle();
    fireEvent.click(screen.getByText("common.start"));
    await settle();
    expect(window.hermesAPI.startGateway).toHaveBeenCalledWith("work");
    expect(window.hermesAPI.gatewayStatus).toHaveBeenCalledWith("work");
  });

  it("passes the selected profile to stop", async () => {
    installApi();
    render(<Gateway profile="work" />);
    await settle();
    fireEvent.click(screen.getByText("common.stop"));
    await settle();
    expect(window.hermesAPI.stopGateway).toHaveBeenCalledWith("work");
  });

  // @lat: [[main-process#Main Process#Remote Gateway management#Pending lifecycle controls]]
  it.each(["start", "stop", "restart"])(
    "keeps %s controls disabled until IPC confirms completion",
    async (action) => {
      let resolve!: (value: unknown) => void;
      const pending = new Promise((r) => {
        resolve = r;
      });
      installApi({
        gatewayStatus: vi.fn().mockResolvedValue(action !== "start"),
        [`${action}Gateway`]: vi.fn().mockReturnValue(pending),
      });
      render(<Gateway profile="work" remoteMode />);
      await settle();
      const commandButton = screen
        .getByText(
          action === "restart" ? "gateway.restart" : `common.${action}`,
        )
        .closest("button") as HTMLButtonElement;
      fireEvent.click(commandButton);
      await settle();
      expect(commandButton.disabled).toBe(true);
      const restartButton = screen
        .queryByText("gateway.restart")
        ?.closest("button");
      if (restartButton) expect(restartButton.disabled).toBe(true);
      await act(async () => {
        resolve(action === "start" ? { success: true, running: true } : true);
        await pending;
      });
      expect(
        screen.getByText(
          action === "stop" ? "gateway.stopped" : "gateway.running",
        ),
      ).toBeTruthy();
    },
  );

  // @lat: [[main-process#Main Process#Remote Gateway management#Gateway target resets]]
  it("resets on same-ID configuration edits and ignores the old command's late result", async () => {
    let changed!: () => void;
    let resolve!: (value: unknown) => void;
    const pending = new Promise((r) => {
      resolve = r;
    });
    const unsubscribe = vi.fn();
    installApi({
      gatewayStatus: vi.fn().mockResolvedValue(false),
      startGateway: vi.fn().mockReturnValue(pending),
      onConnectionConfigChanged: vi.fn().mockImplementation((callback) => {
        changed = callback;
        return unsubscribe;
      }),
    });
    const { unmount } = render(<Gateway profile="work" remoteMode />);
    await settle();
    fireEvent.click(screen.getByText("common.start"));
    await act(async () => {
      changed();
    });
    await settle();
    const callsBefore = (
      window.hermesAPI.gatewayStatus as ReturnType<typeof vi.fn>
    ).mock.calls.length;
    await act(async () => {
      resolve({ success: true, running: true });
      await pending;
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(screen.getByText("gateway.stopped")).toBeTruthy();
    expect(window.hermesAPI.gatewayStatus).toHaveBeenCalledTimes(callsBefore);
    unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  // @lat: [[main-process#Main Process#Remote Gateway management#Unconfirmed commands remain blocked]]
  it("keeps lifecycle controls blocked after an unconfirmed timeout until a refresh confirms completion", async () => {
    let pending = false;
    let running = true;
    installApi({
      gatewayStatus: vi.fn().mockImplementation(async () => running),
      gatewayCommandPending: vi.fn().mockImplementation(async () => pending),
      stopGateway: vi.fn().mockImplementation(async () => {
        pending = true;
        throw new Error(
          "Completion unconfirmed; server may still be processing",
        );
      }),
    });
    render(<Gateway profile="work" remoteMode />);
    await settle();
    fireEvent.click(screen.getByText("common.stop"));
    await settle();
    expect(
      (screen.getByText("common.stop").closest("button") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      screen.getByText(
        "Completion unconfirmed; server may still be processing",
      ),
    ).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(
      screen.getByText(
        "Completion unconfirmed; server may still be processing",
      ),
    ).toBeTruthy();
    expect(
      (screen.getByText("common.stop").closest("button") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    pending = false;
    running = false;
    fireEvent.click(screen.getByText("gateway.refresh"));
    await settle();
    expect(
      (screen.getByText("common.start").closest("button") as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(screen.getByText("gateway.stopped")).toBeTruthy();
    expect(
      screen.queryByText(
        "Completion unconfirmed; server may still be processing",
      ),
    ).toBeNull();
  });

  // @lat: [[main-process#Main Process#Remote Gateway management#Terminal Gateway failure remains visible]]
  it.each([true, false])(
    "preserves a genuine terminal Stop failure when a later refresh reports running=%s",
    async (afterFailureRunning) => {
      let running = true;
      installApi({
        gatewayStatus: vi.fn().mockImplementation(async () => running),
        stopGateway: vi.fn().mockImplementation(async () => {
          running = afterFailureRunning;
          throw new Error("Remote gateway stop failed (exit 1).");
        }),
      });
      render(<Gateway profile="work" remoteMode />);
      await settle();
      fireEvent.click(screen.getByText("common.stop"));
      await settle();
      fireEvent.click(screen.getByText("gateway.refresh"));
      await settle();
      expect(
        screen.getByText(
          afterFailureRunning ? "gateway.running" : "gateway.stopped",
        ),
      ).toBeTruthy();
      expect(
        screen.getByText("Remote gateway stop failed (exit 1)."),
      ).toBeTruthy();
      expect(
        (
          screen
            .getByText(afterFailureRunning ? "common.stop" : "common.start")
            .closest("button") as HTMLButtonElement
        ).disabled,
      ).toBe(false);
    },
  );

  it("preserves a genuine remote Restart failure when the old gateway remains running", async () => {
    installApi({
      restartGateway: vi
        .fn()
        .mockRejectedValue(
          new Error("Remote gateway restart failed (exit 1)."),
        ),
    });
    render(<Gateway profile="work" remoteMode />);
    await settle();
    fireEvent.click(screen.getByText("gateway.restart"));
    await settle();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(screen.getByText("gateway.running")).toBeTruthy();
    expect(
      screen.getByText("Remote gateway restart failed (exit 1)."),
    ).toBeTruthy();
    expect(
      (
        screen
          .getByText("gateway.restart")
          .closest("button") as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  // @lat: [[main-process#Main Process#Remote Gateway management#Pending actions after teardown]]
  it.each(["start", "restart"])(
    "does not schedule status reads when pending %s resolves after unmount",
    async (action) => {
      let resolve!: (result: unknown) => void;
      const pending = new Promise((r) => {
        resolve = r;
      });
      installApi({
        gatewayStatus: vi.fn().mockResolvedValue(action === "restart"),
        [action === "start" ? "startGateway" : "restartGateway"]: vi
          .fn()
          .mockReturnValue(pending),
      });
      const { unmount } = render(<Gateway profile="work" remoteMode />);
      await settle();
      fireEvent.click(
        screen.getByText(
          action === "start" ? "common.start" : "gateway.restart",
        ),
      );
      const before = (
        window.hermesAPI.gatewayStatus as ReturnType<typeof vi.fn>
      ).mock.calls.length;
      unmount();
      await act(async () => {
        resolve(action === "start" ? { success: true, running: false } : true);
        await pending;
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15000);
      });
      expect(window.hermesAPI.gatewayStatus).toHaveBeenCalledTimes(before);
      expect(window.hermesAPI.getMessagingPlatforms).toHaveBeenCalledTimes(1);
    },
  );

  it("drops the pending 5 s status check when the screen goes away (profile switch remounts it)", async () => {
    installApi({ gatewayStatus: vi.fn().mockResolvedValue(false) });
    const { unmount } = render(<Gateway profile="work" />);
    await settle();
    fireEvent.click(screen.getByText("common.start"));
    await settle();
    const callsBefore = (
      window.hermesAPI.gatewayStatus as ReturnType<typeof vi.fn>
    ).mock.calls.length;
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    // Nothing queried the old profile's status after the unmount.
    expect(
      (window.hermesAPI.gatewayStatus as ReturnType<typeof vi.fn>).mock.calls
        .length,
    ).toBe(callsBefore);
  });

  // @lat: [[main-process#Main Process#Remote Gateway management#Remote restart failure explanation]]
  it("preserves a pending remote restart's actual failure explanation across status refresh", async () => {
    const explanation =
      "Remote gateway restart completion could not be confirmed. The server may still be processing the command.";
    let pending = false;
    installApi({
      gatewayCommandPending: vi.fn().mockImplementation(async () => pending),
      restartGateway: vi.fn().mockImplementation(async () => {
        pending = true;
        throw new Error(explanation);
      }),
    });
    render(<Gateway profile="work" remoteMode />);
    await settle();
    fireEvent.click(screen.getByText("gateway.restart"));
    await settle();
    expect(screen.getByText(explanation)).toBeTruthy();
    expect(screen.queryByText("gateway.restartFailed")).toBeNull();
    expect(
      (
        screen
          .getByText("gateway.restart")
          .closest("button") as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(screen.getByText(explanation)).toBeTruthy();
    pending = false;
    fireEvent.click(screen.getByText("gateway.refresh"));
    await settle();
    expect(screen.queryByText(explanation)).toBeNull();
    expect(
      (
        screen
          .getByText("gateway.restart")
          .closest("button") as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });
});
