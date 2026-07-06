import { buildExecApprovalPendingReplyPayload } from "openclaw/plugin-sdk/approval-reply-runtime";
// Signal tests cover core plugin behavior.
import {
  createMessageReceiptFromOutboundResults,
  verifyChannelMessageAdapterCapabilityProofs,
} from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import * as fetchRuntime from "openclaw/plugin-sdk/fetch-runtime";
import {
  createPluginSetupWizardConfigure,
  createPluginSetupWizardStatus,
  createQueuedWizardPrompter,
  runSetupWizardConfigure,
  runSetupWizardPrepare,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearSignalApprovalReactionTargetsForTest,
  resolveSignalApprovalReactionTargetWithPersistence,
} from "./approval-reactions.js";
import { signalPlugin } from "./channel.js";
import * as clientModule from "./client-adapter.js";
import { classifySignalCliLogLine } from "./daemon.js";
import {
  looksLikeUuid,
  resolveSignalPeerId,
  resolveSignalRecipient,
  resolveSignalSender,
} from "./identity.js";
import { probeSignal } from "./probe.js";
import { clearSignalRuntime } from "./runtime.js";
import {
  buildSignalContainerRunArgs,
  createSignalContainerQrLink,
  defaultSignalContainerSetupRunner,
  showSignalLinkedDeviceQrPrompt,
  validateSignalContainerAbout,
  validateSignalContainerLinkedAccount,
} from "./setup-container.js";
import {
  createSignalCliPathTextInput,
  normalizeSignalAccountInput,
  parseSignalAllowFromEntries,
  prepareSignalSetupWizard,
  setSignalContainerSetupRunnerForTest,
  setSignalSetupServerProbeForTest,
  signalDmPolicy,
  signalSetupAdapter,
} from "./setup-core.js";

const { execFileAsyncMock, execFileMock, installSignalCliMock } = vi.hoisted(() => {
  const execFileAsyncMock = vi.fn();
  const execFileMock = vi.fn();
  (execFileMock as unknown as Record<symbol, typeof execFileAsyncMock>)[
    Symbol.for("nodejs.util.promisify.custom")
  ] = execFileAsyncMock;
  return {
    execFileAsyncMock,
    execFileMock,
    installSignalCliMock: vi.fn(),
  };
});

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

vi.mock("./install-signal-cli.js", () => ({
  installSignalCli: installSignalCliMock,
}));

const getSignalSetupStatus = createPluginSetupWizardStatus(signalPlugin);
const configureSignalSetup = createPluginSetupWizardConfigure(signalPlugin);

afterEach(() => {
  vi.restoreAllMocks();
  setSignalContainerSetupRunnerForTest(undefined);
  setSignalSetupServerProbeForTest(undefined);
  execFileAsyncMock.mockReset();
  execFileMock.mockReset();
  installSignalCliMock.mockReset();
});

describe("looksLikeUuid", () => {
  it("accepts hyphenated UUIDs", () => {
    expect(looksLikeUuid("123e4567-e89b-12d3-a456-426614174000")).toBe(true);
  });

  it("accepts compact UUIDs", () => {
    expect(looksLikeUuid("123e4567e89b12d3a456426614174000")).toBe(true); // pragma: allowlist secret
  });

  it("accepts uuid-like hex values with letters", () => {
    expect(looksLikeUuid("abcd-1234")).toBe(true);
  });

  it("rejects numeric ids and phone-like values", () => {
    expect(looksLikeUuid("1234567890")).toBe(false);
    expect(looksLikeUuid("+15555551212")).toBe(false);
  });
});

describe("signal sender identity", () => {
  it("prefers sourceNumber over sourceUuid", () => {
    const sender = resolveSignalSender({
      sourceNumber: " +15550001111 ",
      sourceUuid: "123e4567-e89b-12d3-a456-426614174000",
    });
    expect(sender).toEqual({
      kind: "phone",
      raw: "+15550001111",
      e164: "+15550001111",
    });
  });

  it("uses sourceUuid when sourceNumber is missing", () => {
    const sender = resolveSignalSender({
      sourceUuid: "123e4567-e89b-12d3-a456-426614174000",
    });
    expect(sender).toEqual({
      kind: "uuid",
      raw: "123e4567-e89b-12d3-a456-426614174000",
    });
  });

  it("maps uuid senders to recipient and peer ids", () => {
    const sender = { kind: "uuid", raw: "123e4567-e89b-12d3-a456-426614174000" } as const;
    expect(resolveSignalRecipient(sender)).toBe("123e4567-e89b-12d3-a456-426614174000");
    expect(resolveSignalPeerId(sender)).toBe("uuid:123e4567-e89b-12d3-a456-426614174000");
  });
});

describe("probeSignal", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("falls back to the direct probe helper when runtime is not initialized", async () => {
    clearSignalRuntime();
    vi.spyOn(clientModule, "signalCheck")
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        error: null,
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        error: null,
      });
    vi.spyOn(clientModule, "signalRpcRequest")
      .mockResolvedValueOnce({ version: "0.13.22" })
      .mockResolvedValueOnce({ version: "0.13.22" });

    const params = {
      cfg: {} as never,
      account: {
        accountId: "default",
        enabled: true,
        configured: true,
        baseUrl: "http://127.0.0.1:8080",
        config: { account: "+15555550123" },
      } as never,
      timeoutMs: 1000,
    };

    const expected = await probeSignal("http://127.0.0.1:8080", 1000, {
      account: "+15555550123",
    });
    const result = await signalPlugin.status!.probeAccount!(params);

    expect(result.ok).toBe(expected.ok);
    expect(result.status).toBe(expected.status);
    expect(result.error).toBe(expected.error);
    expect(result.version).toBe(expected.version);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("extracts version from {version} result", async () => {
    vi.spyOn(clientModule, "signalCheck").mockResolvedValueOnce({
      ok: true,
      status: 200,
      error: null,
    });
    vi.spyOn(clientModule, "signalRpcRequest").mockResolvedValueOnce({ version: "0.13.22" });

    const res = await probeSignal("http://127.0.0.1:8080", 1000, {
      account: "+15555550123",
    });

    expect(res.ok).toBe(true);
    expect(res.version).toBe("0.13.22");
    expect(res.status).toBe(200);
    expect(res.readiness).toBe("ready");
  });

  it("returns ok=false when /check fails", async () => {
    vi.spyOn(clientModule, "signalCheck").mockResolvedValueOnce({
      ok: false,
      status: 503,
      error: "HTTP 503",
    });

    const res = await probeSignal("http://127.0.0.1:8080", 1000, {
      account: "+15555550123",
    });

    expect(res.ok).toBe(false);
    expect(res.status).toBe(503);
    expect(res.version).toBe(null);
    expect(res.readiness).toBe("unreachable");
  });

  it("reports missing account after probing transport reachability", async () => {
    const signalCheck = vi.spyOn(clientModule, "signalCheck").mockResolvedValueOnce({
      ok: true,
      status: 200,
      error: null,
    });
    const signalRpcRequest = vi
      .spyOn(clientModule, "signalRpcRequest")
      .mockResolvedValueOnce({ version: "0.13.22" });

    const res = await probeSignal("http://127.0.0.1:8080", 1000, {
      apiMode: "container",
    });

    expect(res.ok).toBe(true);
    expect(res.readiness).toBe("account_missing");
    expect(res.error).toBe("Signal account is not configured");
    expect(res.version).toBe("0.13.22");
    expect(signalCheck).toHaveBeenCalledWith("http://127.0.0.1:8080", 1000, {
      account: undefined,
      apiMode: "container",
      requireReceive: false,
    });
    expect(signalRpcRequest).toHaveBeenCalledWith("version", undefined, {
      apiMode: "container",
      baseUrl: "http://127.0.0.1:8080",
      timeoutMs: 1000,
    });
  });

  it("reports container receive failures separately from unreachable transport", async () => {
    vi.spyOn(clientModule, "signalCheck").mockResolvedValueOnce({
      ok: false,
      status: 200,
      error: "Signal container receive endpoint did not upgrade to WebSocket (HTTP 200)",
    });

    const res = await probeSignal("http://127.0.0.1:8080", 1000, {
      account: "+15555550123",
      apiMode: "container",
    });

    expect(res.ok).toBe(false);
    expect(res.status).toBe(200);
    expect(res.readiness).toBe("receive_unavailable");
  });

  it("does not report a container probe ready when the account is not linked", async () => {
    vi.spyOn(clientModule, "signalCheck").mockResolvedValueOnce({
      ok: true,
      status: 101,
      error: null,
    });
    vi.spyOn(clientModule, "signalRpcRequest").mockResolvedValueOnce({ version: "0.13.22" });
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify(["+15555550999"]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.spyOn(fetchRuntime, "resolveFetch").mockReturnValue(fetchImpl as unknown as typeof fetch);

    const res = await probeSignal("http://signal-cli:8080", 1000, {
      account: "+15555550123",
      apiMode: "container",
    });

    expect(fetchImpl).toHaveBeenCalledWith("http://signal-cli:8080/v1/accounts", {
      method: "GET",
      signal: expect.any(AbortSignal),
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(101);
    expect(res.version).toBe("0.13.22");
    expect(res.readiness).toBe("receive_unavailable");
    expect(res.error).toContain("Signal container does not list +15555550123");
  });

  it("reports a container probe ready when the account is linked", async () => {
    vi.spyOn(clientModule, "signalCheck").mockResolvedValueOnce({
      ok: true,
      status: 101,
      error: null,
    });
    vi.spyOn(clientModule, "signalRpcRequest").mockResolvedValueOnce({ version: "0.13.22" });
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify(["+15555550123"]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.spyOn(fetchRuntime, "resolveFetch").mockReturnValue(fetchImpl as unknown as typeof fetch);

    const res = await probeSignal("http://signal-cli:8080", 1000, {
      account: "+15555550123",
      apiMode: "container",
    });

    expect(fetchImpl).toHaveBeenCalledWith("http://signal-cli:8080/v1/accounts", {
      method: "GET",
      signal: expect.any(AbortSignal),
    });
    expect(res.ok).toBe(true);
    expect(res.status).toBe(101);
    expect(res.version).toBe("0.13.22");
    expect(res.readiness).toBe("ready");
  });

  it("lets generic probe wrapper failures fall back to generic capability output", () => {
    const lines = signalPlugin.status!.formatCapabilitiesProbe!({
      probe: { ok: false, error: "probe timed out after 30000ms" } as never,
    });

    expect(lines).toEqual([]);
  });

  it("setup status lines use the selected account cliPath", async () => {
    const status = await getSignalSetupStatus({
      cfg: {
        channels: {
          signal: {
            cliPath: "/tmp/root-signal-cli",
            accounts: {
              work: {
                cliPath: "/tmp/work-signal-cli",
              },
            },
          },
        },
      } as never,
      accountOverrides: { signal: "work" },
    });

    expect(status.statusLines).toContain("signal-cli: missing (/tmp/work-signal-cli)");
  });

  it("setup status does not require local signal-cli for container transport", async () => {
    const status = await getSignalSetupStatus({
      cfg: {
        channels: {
          signal: {
            enabled: true,
            account: "+15555550123",
            httpUrl: "http://signal-cli:8080",
            autoStart: false,
            apiMode: "container",
          },
        },
      } as OpenClawConfig,
      accountOverrides: {},
    });

    expect(status.configured).toBe(true);
    expect(status.quickstartScore).toBe(1);
    expect(status.statusLines).toContain("Signal transport: container");
    expect(status.statusLines.some((line) => line.includes("signal-cli: missing"))).toBe(false);
  });

  it("keeps endpoint-only Signal setup incomplete until an account is configured", async () => {
    const status = await getSignalSetupStatus({
      cfg: {
        channels: {
          signal: {
            enabled: true,
            httpUrl: "http://signal-cli:8080",
            autoStart: false,
            apiMode: "container",
          },
        },
      } as OpenClawConfig,
      accountOverrides: {},
    });

    expect(status.configured).toBe(false);
    expect(status.quickstartScore).toBe(0);
    expect(status.statusLines).toContain("Signal: needs setup");
    expect(status.statusLines).toContain("Signal transport: container");
    expect(status.statusLines.some((line) => line.includes("signal-cli: missing"))).toBe(false);
  });

  it("setup status uses the configured default account for external transport", async () => {
    const status = await getSignalSetupStatus({
      cfg: {
        channels: {
          signal: {
            defaultAccount: "work",
            accounts: {
              work: {
                account: "+15555550123",
                httpUrl: "http://signal-cli:8080",
                autoStart: false,
              },
            },
          },
        },
      } as OpenClawConfig,
      accountOverrides: {},
    });

    expect(status.configured).toBe(true);
    expect(status.quickstartScore).toBe(1);
    expect(status.statusLines).toContain("Signal transport: existing Signal server");
    expect(status.statusLines.some((line) => line.includes("signal-cli: missing"))).toBe(false);
  });

  it("setup status uses configured defaultAccount for omitted cliPath lookup", async () => {
    const status = await getSignalSetupStatus({
      cfg: {
        channels: {
          signal: {
            cliPath: "/tmp/root-signal-cli",
            defaultAccount: "work",
            accounts: {
              work: {
                cliPath: "/tmp/work-signal-cli",
              },
            },
          },
        },
      } as never,
      accountOverrides: {},
    });

    expect(status.statusLines).toContain("signal-cli: missing (/tmp/work-signal-cli)");
  });

  it("uses configured defaultAccount for omitted setup configured state", async () => {
    const status = await getSignalSetupStatus({
      cfg: {
        channels: {
          signal: {
            defaultAccount: "work",
            cliPath: "/tmp/root-signal-cli",
            accounts: {
              alerts: {
                cliPath: "/tmp/alerts-signal-cli",
              },
              work: {
                cliPath: "",
                account: "+15555550123",
                httpHost: "",
                httpUrl: "",
              },
            },
          },
        },
      } as OpenClawConfig,
      accountOverrides: {},
    });

    expect(status.configured).toBe(true);
  });

  it("shows focused signal-cli path help before the cliPath prompt", () => {
    const input = createSignalCliPathTextInput(async () => true);

    expect(input.helpTitle).toBe("signal-cli path");
    expect(input.helpLines).toEqual([
      "This is the command OpenClaw runs for local signal-cli setup.",
      "Use the full path if it is not on PATH, for example /opt/homebrew/bin/signal-cli.",
    ]);
  });
});

describe("signal outbound", () => {
  it("chunks outbound text without requiring Signal runtime initialization", () => {
    clearSignalRuntime();
    const chunker = signalPlugin.outbound?.chunker;
    if (!chunker) {
      throw new Error("signal outbound.chunker unavailable");
    }

    expect(chunker("alpha beta", 5)).toEqual(["alpha", "beta"]);
  });

  it("preserves the local approval prompt suppressor through attached-result composition", () => {
    const suppressor = signalPlugin.outbound?.shouldSuppressLocalPayloadPrompt;
    if (!suppressor) {
      throw new Error("signal outbound approval suppressor unavailable");
    }

    expect(
      suppressor({
        cfg: {
          channels: {
            signal: {
              enabled: true,
              allowFrom: ["+15551230000"],
            },
          },
          approvals: {
            exec: {
              enabled: true,
            },
          },
        } as OpenClawConfig,
        accountId: "default",
        payload: {
          text: "Approval required.",
          channelData: {
            execApproval: {
              approvalId: "exec-1",
              approvalSlug: "exec-1",
              approvalKind: "exec",
              sessionKey: "agent:main:signal:+15551230000",
            },
          },
        },
        hint: {
          kind: "approval-pending",
          approvalKind: "exec",
          nativeRouteActive: true,
        },
      }),
    ).toBe(true);
  });

  it("registers structured approval payloads for reactions after delivery", async () => {
    clearSignalApprovalReactionTargetsForTest();
    const cfg = {
      channels: {
        signal: {
          account: "+15550009999",
          allowFrom: ["+15551230000"],
        },
      },
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "signal", to: "+15551230000" }],
        },
      },
    } as OpenClawConfig;
    const payload = buildExecApprovalPendingReplyPayload({
      approvalId: "exec-after-delivery",
      approvalSlug: "exec-aft",
      allowedDecisions: ["allow-once", "deny"],
      command: "printf test",
      host: "gateway",
      agentId: "main",
      sessionKey: "agent:main:signal:direct:+15551230000",
    });
    const rendered = await signalPlugin.outbound?.renderPresentation?.({
      payload,
      presentation: payload.presentation!,
      ctx: {
        cfg,
        to: "+15551230000",
        text: payload.text ?? "",
        accountId: "default",
        payload,
      },
    });
    expect(rendered?.text).toContain("React with:\n\n👍 Allow Once\n👎 Deny");

    await signalPlugin.outbound?.afterDeliverPayload?.({
      cfg,
      target: {
        channel: "signal",
        to: "+15551230000",
        accountId: "default",
      },
      payload: rendered!,
      results: [
        {
          channel: "signal",
          messageId: "1700000000099",
        },
      ],
    });

    await expect(
      resolveSignalApprovalReactionTargetWithPersistence({
        accountId: "default",
        conversationKey: "+15551230000",
        messageId: "1700000000099",
        reactionKey: "👍",
        targetAuthor: "+15550009999",
      }),
    ).resolves.toEqual({
      approvalId: "exec-after-delivery",
      approvalKind: "exec",
      decision: "allow-once",
      route: {
        deliveryMode: "target",
        to: "+15551230000",
        accountId: "default",
        agentId: "main",
        sessionKey: "agent:main:signal:direct:+15551230000",
      },
    });
  });

  it("renders reaction hints only from structured approval payloads", async () => {
    const cfg = {
      channels: {
        signal: {
          account: "+15550009999",
          allowFrom: ["+15551230000"],
        },
      },
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "signal", to: "+15551230000" }],
        },
      },
    } as OpenClawConfig;
    const payload = buildExecApprovalPendingReplyPayload({
      approvalId: "exec-rendered-approval",
      approvalSlug: "exec-ren",
      allowedDecisions: ["allow-once", "deny"],
      command: "printf test",
      host: "gateway",
    });
    const rendered = await signalPlugin.outbound?.renderPresentation?.({
      payload,
      presentation: payload.presentation!,
      ctx: {
        cfg,
        to: "+15551230000",
        text: payload.text ?? "",
        accountId: "default",
        payload,
      },
    });

    expect(rendered?.text).toContain("React with:\n\n👍 Allow Once\n👎 Deny");
    expect(
      await signalPlugin.outbound?.renderPresentation?.({
        payload: {
          text: [
            "The docs show this example:",
            "Exec approval required",
            "ID: exec-rendered-approval",
            "",
            "Reply with: /approve exec-rendered-approval allow-once|deny",
          ].join("\n"),
          presentation: payload.presentation,
        },
        presentation: payload.presentation!,
        ctx: {
          cfg,
          to: "+15551230000",
          text: payload.text ?? "",
          accountId: "default",
          payload,
        },
      }),
    ).toBeNull();
  });

  it("declares message adapter durable text and media with receipt proofs", async () => {
    const send = vi.fn(async (_to: string, _text: string, opts: { mediaUrl?: string } = {}) => {
      const messageId = opts.mediaUrl ? "signal-media-1" : "signal-text-1";
      return {
        messageId,
        receipt: createMessageReceiptFromOutboundResults({
          results: [{ channel: "signal", messageId }],
          kind: opts.mediaUrl ? "media" : "text",
        }),
      };
    });
    const deps = { signal: send };

    const proofResults = await verifyChannelMessageAdapterCapabilityProofs({
      adapterName: "signal",
      adapter: signalPlugin.message!,
      proofs: {
        text: async () => {
          const result = await signalPlugin.message?.send?.text?.({
            cfg: {} as OpenClawConfig,
            to: "signal:+15555550123",
            text: "hello",
            deps,
          } as Parameters<NonNullable<typeof signalPlugin.message.send.text>>[0] & {
            deps: typeof deps;
          });
          expect(send).toHaveBeenCalledWith("signal:+15555550123", "hello", {
            cfg: {},
            maxBytes: undefined,
            accountId: undefined,
          });
          expect(result?.receipt.platformMessageIds).toEqual(["signal-text-1"]);
        },
        media: async () => {
          const result = await signalPlugin.message?.send?.media?.({
            cfg: {} as OpenClawConfig,
            to: "signal:+15555550123",
            text: "image",
            mediaUrl: "https://example.com/image.png",
            deps,
          } as Parameters<NonNullable<typeof signalPlugin.message.send.media>>[0] & {
            deps: typeof deps;
          });
          expect(send).toHaveBeenCalledWith("signal:+15555550123", "image", {
            cfg: {},
            mediaUrl: "https://example.com/image.png",
            maxBytes: undefined,
            accountId: undefined,
          });
          expect(result?.receipt.platformMessageIds).toEqual(["signal-media-1"]);
        },
      },
    });

    expect(proofResults).toEqual([
      { capability: "text", status: "verified" },
      { capability: "media", status: "verified" },
      { capability: "poll", status: "not_declared" },
      { capability: "payload", status: "not_declared" },
      { capability: "silent", status: "not_declared" },
      { capability: "replyTo", status: "not_declared" },
      { capability: "thread", status: "not_declared" },
      { capability: "nativeQuote", status: "not_declared" },
      { capability: "messageSendingHooks", status: "not_declared" },
      { capability: "batch", status: "not_declared" },
      { capability: "reconcileUnknownSend", status: "not_declared" },
      { capability: "afterSendSuccess", status: "not_declared" },
      { capability: "afterCommit", status: "not_declared" },
    ]);
  });
});

describe("classifySignalCliLogLine", () => {
  it("treats INFO/DEBUG as log", () => {
    expect(classifySignalCliLogLine("INFO  DaemonCommand - Started")).toBe("log");
    expect(classifySignalCliLogLine("DEBUG Something")).toBe("log");
  });

  it("treats routine warnings as logs and errors as error state", () => {
    expect(classifySignalCliLogLine("WARN  Something")).toBe("log");
    expect(classifySignalCliLogLine("WARNING Something")).toBe("log");
    expect(classifySignalCliLogLine("ERROR Something")).toBe("error");
  });

  it("treats failures without explicit severity as error", () => {
    expect(classifySignalCliLogLine("Failed to initialize HTTP Server - oops")).toBe("error");
    expect(classifySignalCliLogLine('Exception in thread "main"')).toBe("error");
  });

  it("returns null for empty lines", () => {
    expect(classifySignalCliLogLine("")).toBe(null);
    expect(classifySignalCliLogLine("   ")).toBe(null);
  });
});

describe("signal setup parsing", () => {
  it("accepts already normalized numbers", () => {
    expect(normalizeSignalAccountInput("+15555550123")).toBe("+15555550123");
  });

  it("normalizes valid E.164 numbers", () => {
    expect(normalizeSignalAccountInput(" +1 (555) 555-0123 ")).toBe("+15555550123");
  });

  it("rejects empty input", () => {
    expect(normalizeSignalAccountInput("   ")).toBeNull();
  });

  it("rejects invalid values", () => {
    expect(normalizeSignalAccountInput("abc")).toBeNull();
    expect(normalizeSignalAccountInput("++--")).toBeNull();
  });

  it("rejects inputs with stray + characters", () => {
    expect(normalizeSignalAccountInput("++12345")).toBeNull();
    expect(normalizeSignalAccountInput("+1+2345")).toBeNull();
  });

  it("rejects numbers that are too short or too long", () => {
    expect(normalizeSignalAccountInput("+1234")).toBeNull();
    expect(normalizeSignalAccountInput("+1234567890123456")).toBeNull();
  });

  it("parses e164, uuid and wildcard entries", () => {
    expect(
      parseSignalAllowFromEntries("+15555550123, uuid:123e4567-e89b-12d3-a456-426614174000, *"),
    ).toEqual({
      entries: ["+15555550123", "uuid:123e4567-e89b-12d3-a456-426614174000", "*"],
    });
  });

  it("normalizes bare uuid values", () => {
    expect(parseSignalAllowFromEntries("123e4567-e89b-12d3-a456-426614174000")).toEqual({
      entries: ["uuid:123e4567-e89b-12d3-a456-426614174000"],
    });
  });

  it("returns validation errors for invalid entries", () => {
    expect(parseSignalAllowFromEntries("uuid:")).toEqual({
      entries: [],
      error: "Invalid uuid entry",
    });
    expect(parseSignalAllowFromEntries("invalid")).toEqual({
      entries: [],
      error: "Invalid entry: invalid",
    });
  });

  it("reads the named-account DM policy instead of the channel root", () => {
    expect(
      signalDmPolicy.getCurrent(
        {
          channels: {
            signal: {
              dmPolicy: "disabled",
              accounts: {
                work: {
                  account: "+15555550123",
                  dmPolicy: "allowlist",
                },
              },
            },
          },
        },
        "work",
      ),
    ).toBe("allowlist");
  });

  it("reports account-scoped config keys for named accounts", () => {
    expect(signalDmPolicy.resolveConfigKeys?.({ channels: { signal: {} } }, "work")).toEqual({
      policyKey: "channels.signal.accounts.work.dmPolicy",
      allowFromKey: "channels.signal.accounts.work.allowFrom",
    });
  });

  it("creates Signal containers with a restart policy", () => {
    expect(
      buildSignalContainerRunArgs({
        containerName: "openclaw-signal",
        hostPort: 18080,
        volumeName: "openclaw-signal",
        image: "bbernhard/signal-cli-rest-api:0.100",
      }),
    ).toEqual([
      "run",
      "-d",
      "--name",
      "openclaw-signal",
      "--restart",
      "unless-stopped",
      "-e",
      "MODE=json-rpc",
      "-p",
      "127.0.0.1:18080:8080",
      "-v",
      "openclaw-signal:/home/.local/share/signal-cli",
      "bbernhard/signal-cli-rest-api:0.100",
    ]);
  });

  it("rejects reused Signal containers that are not in json-rpc mode", () => {
    expect(
      validateSignalContainerAbout({
        versions: ["v1", "v2"],
        mode: "native",
      }),
    ).toEqual({
      ok: false,
      error:
        "Signal container must run in json-rpc mode for OpenClaw receive support (found native). " +
        "Recreate it with MODE=json-rpc or choose the existing server setup path.",
    });
  });

  it("accepts json-rpc Signal container about responses", () => {
    expect(
      validateSignalContainerAbout({
        versions: ["v1", "v2"],
        mode: "json-rpc",
      }),
    ).toEqual({ ok: true });
  });

  it("reads raw Signal container QR link responses as text", async () => {
    const response = new Response("sgnl://linkdevice?uuid=abc&pub_key=def", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
    const textSpy = vi.spyOn(response, "text").mockRejectedValue(new Error("unbounded text"));
    const fetchImpl = vi.fn(async () => response);
    vi.spyOn(fetchRuntime, "resolveFetch").mockReturnValue(fetchImpl as unknown as typeof fetch);

    await expect(
      createSignalContainerQrLink({
        httpUrl: "signal-cli:8080",
        containerName: "openclaw-signal",
      }),
    ).resolves.toEqual({
      ok: true,
      qrLink: "sgnl://linkdevice?uuid=abc&pub_key=def",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://signal-cli:8080/v1/qrcodelink/raw?device_name=OpenClaw%20openclaw-signal",
      {
        method: "GET",
        signal: expect.any(AbortSignal),
      },
    );
    expect(textSpy).not.toHaveBeenCalled();
  });

  it("extracts Signal container QR links from JSON responses", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ device_link_uri: "sgnl://linkdevice?uuid=abc&pub_key=def" }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
    );
    vi.spyOn(fetchRuntime, "resolveFetch").mockReturnValue(fetchImpl as unknown as typeof fetch);

    await expect(
      createSignalContainerQrLink({
        httpUrl: "http://127.0.0.1:18080",
        containerName: "openclaw-signal",
      }),
    ).resolves.toEqual({
      ok: true,
      qrLink: "sgnl://linkdevice?uuid=abc&pub_key=def",
    });
  });

  it("reports created Docker container cleanup guidance when setup later fails", async () => {
    execFileAsyncMock.mockImplementation(async (_cmd: string, args: string[]) => {
      switch (args[0]) {
        case "version":
          return { stdout: "27.0.0\n", stderr: "" };
        case "inspect":
          throw Object.assign(new Error("No such object"), {
            code: 1,
            stdout: "",
            stderr: "No such object: openclaw-signal",
          });
        case "run":
          return { stdout: "container-id\n", stderr: "" };
        default:
          throw new Error(`unexpected docker args: ${args.join(" ")}`);
      }
    });
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === "http://127.0.0.1:18080/v1/about") {
        return new Response(JSON.stringify({ versions: ["v1", "v2"], mode: "json-rpc" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "http://127.0.0.1:18080/v1/accounts") {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (
        url === "http://127.0.0.1:18080/v1/qrcodelink/raw?device_name=OpenClaw%20openclaw-signal"
      ) {
        return new Response("qr unavailable", { status: 500 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.spyOn(fetchRuntime, "resolveFetch").mockReturnValue(fetchImpl as unknown as typeof fetch);

    await expect(
      defaultSignalContainerSetupRunner({
        containerName: "openclaw-signal",
        hostPort: 18080,
        image: "bbernhard/signal-cli-rest-api:0.100",
        prompter: createQueuedWizardPrompter({}).prompter,
      }),
    ).resolves.toEqual({
      ok: false,
      error: [
        "Signal QR link failed: HTTP 500",
        "",
        "OpenClaw already created or started Docker container openclaw-signal.",
        "Run setup again to reuse it, or remove it with:",
        "docker rm -f openclaw-signal",
      ].join("\n"),
    });
    expect(execFileAsyncMock).toHaveBeenCalledWith(
      "docker",
      expect.arrayContaining(["run", "--name", "openclaw-signal"]),
      expect.any(Object),
    );
  });

  it("bounds Signal container account-list JSON reads during setup", async () => {
    const response = new Response(JSON.stringify(["+15555550123"]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    const jsonSpy = vi.spyOn(response, "json").mockRejectedValue(new Error("unbounded json"));
    const fetchImpl = vi.fn(async () => response);
    vi.spyOn(fetchRuntime, "resolveFetch").mockReturnValue(fetchImpl as unknown as typeof fetch);

    await expect(
      validateSignalContainerLinkedAccount({
        httpUrl: "http://127.0.0.1:18080",
        account: "+15555550123",
      }),
    ).resolves.toEqual({ ok: true });
    expect(jsonSpy).not.toHaveBeenCalled();
  });

  it("shows a terminal QR for Signal linked-device setup", async () => {
    const prompter = {
      note: vi.fn(async () => undefined),
      plain: vi.fn(async () => undefined),
    };

    await showSignalLinkedDeviceQrPrompt({
      link: "sgnl://linkdevice?uuid=abc&pub_key=def",
      prompter: prompter as never,
    });

    expect(prompter.note).toHaveBeenCalledWith(
      expect.stringContaining("scan the QR code below"),
      "Signal container",
    );
    expect(prompter.note).toHaveBeenCalledWith(
      expect.stringContaining("sgnl://linkdevice?uuid=abc&pub_key=def"),
      "Signal container",
    );
    expect(prompter.plain).toHaveBeenCalledWith(expect.stringContaining("█"));
  });

  it("configures native signal-cli auto-start setup through the wizard", async () => {
    const cliPath = "/tmp/openclaw-missing-signal-cli-native-setup";
    const prompts = createQueuedWizardPrompter({
      selectValues: ["native"],
      textValues: [cliPath, "+1 (555) 555-0123", "~/.local/share/signal-cli"],
    });

    const result = await runSetupWizardConfigure({
      configure: configureSignalSetup,
      cfg: {
        channels: {
          signal: {
            cliPath,
          },
        },
      } as OpenClawConfig,
      prompter: prompts.prompter,
    });

    expect(result.cfg.channels?.signal).toMatchObject({
      enabled: true,
      account: "+15555550123",
      cliPath,
      configPath: "~/.local/share/signal-cli",
      autoStart: true,
    });
    expect(prompts.note).toHaveBeenCalledWith(
      expect.stringContaining("/opt/homebrew/bin/signal-cli"),
      "signal-cli path",
    );
    expect(prompts.note).toHaveBeenCalledWith(
      expect.stringContaining("for example +15555550123"),
      "Signal phone number",
    );
    expect(prompts.note).toHaveBeenCalledWith(
      expect.stringContaining("Example: ~/.local/share/signal-cli"),
      "signal-cli config path",
    );
    expect(
      prompts.text.mock.calls.map(([prompt]) => (prompt as { message?: string }).message),
    ).toEqual(["signal-cli path", "Signal phone number", "signal-cli config path (optional)"]);
    expect(result.cfg.channels?.signal?.httpUrl).toBeUndefined();
    expect(result.cfg.channels?.signal?.apiMode).toBeUndefined();
  });

  it("returns to the Signal setup choice after signal-cli auto-install fails", async () => {
    installSignalCliMock.mockResolvedValueOnce({
      ok: false,
      error: "Signal setup hit an error while installing signal-cli.",
    });
    const runner = vi.fn(async () => ({
      ok: true as const,
      account: "+15555550123",
      httpUrl: "http://127.0.0.1:18080",
      containerName: "openclaw-signal",
      volumeName: "openclaw-signal",
    }));
    setSignalContainerSetupRunnerForTest(runner);
    const prompts = createQueuedWizardPrompter({
      selectValues: ["native", "container"],
      confirmValues: [true],
      textValues: ["openclaw-signal", "18080"],
    });

    const result = await runSetupWizardConfigure({
      configure: configureSignalSetup,
      cfg: {
        channels: {
          signal: {
            cliPath: "/tmp/openclaw-missing-signal-cli-install-retry",
          },
        },
      } as OpenClawConfig,
      prompter: prompts.prompter,
      options: { allowSignalInstall: true },
    });

    expect(installSignalCliMock).toHaveBeenCalledTimes(1);
    expect(prompts.note).toHaveBeenCalledWith(
      "Signal setup hit an error while installing signal-cli.",
      "Signal",
    );
    expect(prompts.select).toHaveBeenCalledTimes(2);
    expect(
      prompts.select.mock.calls.map(([prompt]) => (prompt as { message?: string }).message),
    ).toEqual([
      "How do you want to set up Signal for OpenClaw?",
      "How do you want to set up Signal for OpenClaw?",
    ]);
    expect(
      prompts.text.mock.calls.map(([prompt]) => (prompt as { message?: string }).message),
    ).not.toContain("signal-cli path");
    expect(result.cfg.channels?.signal).toMatchObject({
      enabled: true,
      account: "+15555550123",
      httpUrl: "http://127.0.0.1:18080",
      autoStart: false,
      apiMode: "container",
    });
    const status = await getSignalSetupStatus({
      cfg: result.cfg,
      accountOverrides: {},
    });
    expect(status.statusLines).toContain("Signal transport: container");
  });

  it("uses an installed signal-cli path for native setup", async () => {
    installSignalCliMock.mockResolvedValueOnce({
      ok: true,
      cliPath: "/tmp/openclaw-installed-signal-cli",
    });
    const prompts = createQueuedWizardPrompter({
      selectValues: ["native"],
      confirmValues: [true],
      textValues: [
        "/tmp/openclaw-installed-signal-cli",
        "+1 (555) 555-0123",
        "~/.local/share/signal-cli",
      ],
    });

    const result = await runSetupWizardConfigure({
      configure: configureSignalSetup,
      cfg: {
        channels: {
          signal: {
            cliPath: "/tmp/openclaw-missing-signal-cli-install-success",
          },
        },
      } as OpenClawConfig,
      prompter: prompts.prompter,
      options: { allowSignalInstall: true },
    });

    expect(installSignalCliMock).toHaveBeenCalledTimes(1);
    expect(prompts.note).toHaveBeenCalledWith(
      "Installed signal-cli at /tmp/openclaw-installed-signal-cli",
      "Signal",
    );
    const textPrompts = prompts.text.mock.calls.map(
      ([prompt]) =>
        prompt as {
          message?: string;
          initialValue?: string;
        },
    );
    expect(textPrompts).toEqual([
      expect.objectContaining({
        message: "signal-cli path",
        initialValue: "/tmp/openclaw-installed-signal-cli",
      }),
      expect.objectContaining({ message: "Signal phone number" }),
      expect.objectContaining({ message: "signal-cli config path (optional)" }),
    ]);
    expect(result.cfg.channels?.signal).toMatchObject({
      enabled: true,
      account: "+15555550123",
      cliPath: "/tmp/openclaw-installed-signal-cli",
      configPath: "~/.local/share/signal-cli",
      autoStart: true,
    });
    expect(result.cfg.channels?.signal?.httpUrl).toBeUndefined();
    expect(result.cfg.channels?.signal?.apiMode).toBeUndefined();
  });

  it("switches stale external setup back to native signal-cli setup", async () => {
    const prompts = createQueuedWizardPrompter({
      selectValues: ["native"],
      confirmValues: [true],
      textValues: ["/tmp/missing-signal-cli-native-switch", ""],
    });

    const result = await runSetupWizardConfigure({
      configure: configureSignalSetup,
      cfg: {
        channels: {
          signal: {
            enabled: true,
            account: "+15555550123",
            cliPath: "/tmp/missing-signal-cli-native-switch",
            configPath: "/tmp/stale-signal-config",
            httpUrl: "http://signal-cli:8080",
            httpHost: "signal-cli",
            httpPort: 8080,
            autoStart: false,
            apiMode: "container",
          },
        },
      } as OpenClawConfig,
      prompter: prompts.prompter,
    });

    expect(result.cfg.channels?.signal).toMatchObject({
      enabled: true,
      account: "+15555550123",
      cliPath: "/tmp/missing-signal-cli-native-switch",
      autoStart: true,
    });
    expect(result.cfg.channels?.signal?.httpUrl).toBeUndefined();
    expect(result.cfg.channels?.signal?.httpHost).toBeUndefined();
    expect(result.cfg.channels?.signal?.httpPort).toBeUndefined();
    expect(result.cfg.channels?.signal?.configPath).toBeUndefined();
    expect(result.cfg.channels?.signal?.apiMode).toBe("native");
  });

  it("preselects native setup for an existing native Signal account", async () => {
    const prompts = createQueuedWizardPrompter({
      selectValues: ["native"],
    });

    await runSetupWizardPrepare({
      prepare: prepareSignalSetupWizard,
      cfg: {
        channels: {
          signal: {
            account: "+15555550123",
          },
        },
      } as OpenClawConfig,
      prompter: prompts.prompter,
    });

    expect(prompts.select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "How do you want to set up Signal for OpenClaw?",
        initialValue: "native",
      }),
    );
  });

  it("preselects container setup when container mode has an existing URL", async () => {
    const prompts = createQueuedWizardPrompter({
      selectValues: ["container"],
    });

    const result = await runSetupWizardPrepare({
      prepare: prepareSignalSetupWizard,
      cfg: {
        channels: {
          signal: {
            account: "+15555550123",
            httpUrl: "http://127.0.0.1:18080",
            autoStart: false,
            apiMode: "container",
          },
        },
      } as OpenClawConfig,
      prompter: prompts.prompter,
    });

    expect(prompts.select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "How do you want to set up Signal for OpenClaw?",
        initialValue: "container",
      }),
    );
    expect(result?.credentialValues?.signalContainerSetupMode).toBe("existing");
  });

  it("connects to an existing Signal server through the wizard", async () => {
    const probe = vi.fn(async () => ({ ok: true as const, version: "0.13.22" }));
    setSignalSetupServerProbeForTest(probe);
    const prompts = createQueuedWizardPrompter({
      selectValues: ["external-native"],
      textValues: ["+15555550123", "http://127.0.0.1:8080"],
    });

    const result = await runSetupWizardConfigure({
      configure: configureSignalSetup,
      prompter: prompts.prompter,
    });

    expect(result.cfg.channels?.signal).toMatchObject({
      enabled: true,
      account: "+15555550123",
      httpUrl: "http://127.0.0.1:8080",
      autoStart: false,
      apiMode: "auto",
    });
    expect(prompts.note).toHaveBeenCalledWith(
      expect.stringContaining("For a local helper, this usually looks like http://127.0.0.1:8080."),
      "Signal server URL",
    );
    expect(probe).toHaveBeenCalledWith({
      httpUrl: "http://127.0.0.1:8080",
      account: "+15555550123",
      apiMode: "auto",
    });
    expect(prompts.progress).toHaveBeenCalledWith("Testing Signal server URL");
    const progress = prompts.progress.mock.results[0]?.value;
    expect(progress?.update).toHaveBeenCalledWith("Testing http://127.0.0.1:8080");
    expect(progress?.stop).toHaveBeenCalledWith("Signal server reachable");
    expect(result.cfg.channels?.signal?.cliPath).toBeUndefined();
  });

  it("does not save an existing container server when the account is not linked", async () => {
    vi.spyOn(clientModule, "signalCheck").mockResolvedValue({
      ok: true,
      status: 101,
      error: null,
    });
    vi.spyOn(clientModule, "signalRpcRequest").mockResolvedValue({
      version: "0.13.22",
    } as never);
    vi.spyOn(clientModule, "detectSignalApiMode").mockResolvedValue("container");
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify(["+15555550999"]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.spyOn(fetchRuntime, "resolveFetch").mockReturnValue(fetchImpl as unknown as typeof fetch);
    const prompts = createQueuedWizardPrompter({
      selectValues: ["external-native"],
      confirmValues: [false],
      textValues: ["+15555550123", "http://signal-cli:8080"],
    });

    const result = await runSetupWizardConfigure({
      configure: configureSignalSetup,
      prompter: prompts.prompter,
    });

    expect(fetchImpl).toHaveBeenCalledWith("http://signal-cli:8080/v1/accounts", {
      method: "GET",
      signal: expect.any(AbortSignal),
    });
    expect(prompts.note).toHaveBeenCalledWith(
      expect.stringContaining("Signal container does not list +15555550123"),
      "Signal server URL",
    );
    expect(prompts.confirm).toHaveBeenCalledWith({
      message: "Try the Signal server URL again?",
      initialValue: true,
    });
    expect(result.cfg.channels?.signal).toBeUndefined();
  });

  it("accepts a bare existing container server URL when the account is linked", async () => {
    vi.spyOn(clientModule, "signalCheck").mockResolvedValue({
      ok: true,
      status: 101,
      error: null,
    });
    vi.spyOn(clientModule, "signalRpcRequest").mockResolvedValue({
      version: "0.13.22",
    } as never);
    vi.spyOn(clientModule, "detectSignalApiMode").mockResolvedValue("container");
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify(["+15555550123"]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.spyOn(fetchRuntime, "resolveFetch").mockReturnValue(fetchImpl as unknown as typeof fetch);
    const prompts = createQueuedWizardPrompter({
      selectValues: ["external-native"],
      textValues: ["+15555550123", "signal-cli:8080"],
    });

    const result = await runSetupWizardConfigure({
      configure: configureSignalSetup,
      prompter: prompts.prompter,
    });

    expect(fetchImpl).toHaveBeenCalledWith("http://signal-cli:8080/v1/accounts", {
      method: "GET",
      signal: expect.any(AbortSignal),
    });
    expect(result.cfg.channels?.signal).toMatchObject({
      account: "+15555550123",
      httpUrl: "signal-cli:8080",
      autoStart: false,
      apiMode: "auto",
    });
  });

  it("retries the Signal server URL until the server check passes", async () => {
    const probe = vi
      .fn()
      .mockResolvedValueOnce({ ok: false as const, error: "connect ECONNREFUSED 127.0.0.1:8080" })
      .mockResolvedValueOnce({ ok: true as const, version: "0.13.22" });
    setSignalSetupServerProbeForTest(probe);
    const prompts = createQueuedWizardPrompter({
      selectValues: ["external-native"],
      confirmValues: [true],
      textValues: ["+15555550123", "http://127.0.0.1:8080", "http://127.0.0.1:18080"],
    });

    const result = await runSetupWizardConfigure({
      configure: configureSignalSetup,
      prompter: prompts.prompter,
    });

    expect(prompts.note).toHaveBeenCalledWith(
      expect.stringContaining(
        "OpenClaw could not reach a working Signal server at http://127.0.0.1:8080.",
      ),
      "Signal server URL",
    );
    expect(prompts.confirm).toHaveBeenCalledWith({
      message: "Try the Signal server URL again?",
      initialValue: true,
    });
    expect(probe).toHaveBeenCalledTimes(2);
    expect(result.cfg.channels?.signal).toMatchObject({
      enabled: true,
      account: "+15555550123",
      httpUrl: "http://127.0.0.1:18080",
      autoStart: false,
      apiMode: "auto",
    });
    const status = await getSignalSetupStatus({
      cfg: result.cfg,
      accountOverrides: {},
    });
    expect(status.statusLines).toContain("Signal transport: existing Signal server");
  });

  it("cancels Signal server URL setup without throwing when the user declines retry", async () => {
    const probe = vi.fn().mockResolvedValueOnce({
      ok: false as const,
      error: "connect ECONNREFUSED 127.0.0.1:8080",
    });
    setSignalSetupServerProbeForTest(probe);
    const prompts = createQueuedWizardPrompter({
      selectValues: ["external-native"],
      confirmValues: [false],
      textValues: ["+15555550123", "http://127.0.0.1:8080"],
    });

    const result = await runSetupWizardConfigure({
      configure: configureSignalSetup,
      prompter: prompts.prompter,
    });

    expect(prompts.confirm).toHaveBeenCalledWith({
      message: "Try the Signal server URL again?",
      initialValue: true,
    });
    expect(prompts.note).toHaveBeenCalledWith(
      "Signal server URL was not saved. Start or fix the Signal helper, then run setup again.",
      "Signal server URL",
    );
    expect(
      prompts.note.mock.calls.some(([message]) =>
        String(message).includes("Then run: openclaw channels status --probe"),
      ),
    ).toBe(false);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(result.cfg.channels?.signal).toBeUndefined();
  });

  it("does not save Signal server URL setup when the server probe throws", async () => {
    const probe = vi.fn().mockRejectedValueOnce(new Error("probe exploded"));
    setSignalSetupServerProbeForTest(probe);
    const prompts = createQueuedWizardPrompter({
      selectValues: ["external-native"],
      confirmValues: [false],
      textValues: ["+15555550123", "http://127.0.0.1:8080"],
    });

    const result = await runSetupWizardConfigure({
      configure: configureSignalSetup,
      prompter: prompts.prompter,
    });

    expect(prompts.note).toHaveBeenCalledWith(
      expect.stringContaining(
        "OpenClaw could not check the Signal server at http://127.0.0.1:8080.",
      ),
      "Signal server URL",
    );
    expect(prompts.note).toHaveBeenCalledWith(
      "Signal server URL was not saved. Start or fix the Signal helper, then run setup again.",
      "Signal server URL",
    );
    expect(prompts.confirm).toHaveBeenCalledWith({
      message: "Try the Signal server URL again?",
      initialValue: true,
    });
    const progress = prompts.progress.mock.results[0]?.value;
    expect(progress?.update).toHaveBeenCalledWith("Testing http://127.0.0.1:8080");
    expect(progress?.stop).toHaveBeenCalledWith();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(result.cfg.channels?.signal).toBeUndefined();
  });

  it("uses auto mode for existing Signal server setup", async () => {
    setSignalSetupServerProbeForTest(async () => ({ ok: true as const, version: "0.13.22" }));
    const prompts = createQueuedWizardPrompter({
      selectValues: ["external-native"],
      confirmValues: [true],
      textValues: ["http://signal-cli:8080"],
    });

    const result = await runSetupWizardConfigure({
      configure: configureSignalSetup,
      cfg: {
        channels: {
          signal: {
            enabled: true,
            account: "+15555550123",
            httpUrl: "http://signal-cli:8080",
            autoStart: false,
            apiMode: "auto",
          },
        },
      } as OpenClawConfig,
      prompter: prompts.prompter,
    });

    expect(result.cfg.channels?.signal).toMatchObject({
      account: "+15555550123",
      httpUrl: "http://signal-cli:8080",
      autoStart: false,
      apiMode: "auto",
    });
  });

  it("prompts with existing host and port for Signal server setup", async () => {
    setSignalSetupServerProbeForTest(async () => ({ ok: true as const, version: "0.13.22" }));
    const prompts = createQueuedWizardPrompter({
      selectValues: ["external-native"],
      confirmValues: [true],
      textValues: ["http://signal-cli:8081"],
    });

    const result = await runSetupWizardConfigure({
      configure: configureSignalSetup,
      cfg: {
        channels: {
          signal: {
            enabled: true,
            account: "+15555550123",
            httpHost: "signal-cli",
            httpPort: 8081,
            autoStart: false,
            apiMode: "auto",
          },
        },
      } as OpenClawConfig,
      prompter: prompts.prompter,
    });

    expect(prompts.text).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Signal server URL",
        initialValue: "http://signal-cli:8081",
      }),
    );
    expect(result.cfg.channels?.signal).toMatchObject({
      account: "+15555550123",
      httpUrl: "http://signal-cli:8081",
      autoStart: false,
      apiMode: "auto",
    });
  });

  it("keeps native daemon auto-start when non-interactive setup supplies bind options", () => {
    const next = signalSetupAdapter.applyAccountConfig?.({
      cfg: {} as OpenClawConfig,
      accountId: "default",
      input: {
        signalNumber: "+15555550123",
        httpHost: "0.0.0.0",
        httpPort: "8081",
      },
    });

    expect(next?.channels?.signal).toMatchObject({
      enabled: true,
      account: "+15555550123",
      httpHost: "0.0.0.0",
      httpPort: 8081,
    });
    expect(next?.channels?.signal?.autoStart).toBeUndefined();
  });

  it("keeps existing Signal server setup as an escape hatch", async () => {
    setSignalSetupServerProbeForTest(async () => ({ ok: true as const, version: "0.13.22" }));
    const prompts = createQueuedWizardPrompter({
      selectValues: ["external-native"],
      textValues: ["+15555550123", "http://signal-cli:8080"],
    });

    const result = await runSetupWizardConfigure({
      configure: configureSignalSetup,
      prompter: prompts.prompter,
    });

    expect(result.cfg.channels?.signal).toMatchObject({
      enabled: true,
      account: "+15555550123",
      httpUrl: "http://signal-cli:8080",
      autoStart: false,
      apiMode: "auto",
    });
    expect(result.cfg.channels?.signal?.cliPath).toBeUndefined();
  });

  it("can set up a Signal Docker container through the wizard", async () => {
    const runner = vi.fn(async () => ({
      ok: true as const,
      account: "+15555550123",
      httpUrl: "http://127.0.0.1:18080",
      containerName: "openclaw-signal",
      volumeName: "openclaw-signal",
      qrLink: "sgnl://linkdevice?uuid=abc",
    }));
    setSignalContainerSetupRunnerForTest(runner);
    const prompts = createQueuedWizardPrompter({
      selectValues: ["container"],
      textValues: ["openclaw-signal", "18080"],
    });

    const result = await runSetupWizardConfigure({
      configure: configureSignalSetup,
      prompter: prompts.prompter,
    });

    expect(prompts.note).toHaveBeenNthCalledWith(
      1,
      [
        "Signal uses a real Signal account with a phone number, not a bot token.",
        "",
        "It is usually best to give OpenClaw its own Signal account and phone number. That keeps OpenClaw messages separate from your personal Signal messages.",
      ].join("\n"),
      "Signal",
    );
    expect(prompts.select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "How do you want to set up Signal for OpenClaw?",
        options: expect.arrayContaining([
          expect.objectContaining({
            label: "Set up a Signal Docker container (Recommended)",
            hint: "Creates a local signal-cli-rest-api container and waits for linking.",
          }),
          expect.objectContaining({
            label: "Use local signal-cli",
          }),
          expect.objectContaining({
            label: "Connect to an existing Signal server",
          }),
        ]),
      }),
    );
    expect(runner).toHaveBeenCalledWith({
      containerName: "openclaw-signal",
      hostPort: 18080,
      image: "bbernhard/signal-cli-rest-api:0.100",
      prompter: prompts.prompter,
    });
    expect(result.cfg.channels?.signal).toMatchObject({
      enabled: true,
      account: "+15555550123",
      httpUrl: "http://127.0.0.1:18080",
      autoStart: false,
      apiMode: "container",
    });
    const status = await getSignalSetupStatus({
      cfg: result.cfg,
      accountOverrides: {},
    });
    expect(status.statusLines).toContain("Signal transport: container");
    expect(prompts.note).toHaveBeenCalledWith(
      expect.stringContaining(
        "Use the default name unless you already have a container named openclaw-signal.",
      ),
      "Signal Docker container",
    );
    expect(prompts.note).toHaveBeenCalledWith(
      expect.stringContaining("Loopback means the Signal helper only listens on this computer."),
      "Signal Docker port",
    );
    expect(prompts.note).toHaveBeenCalledWith(
      [
        "Signal is set up.",
        "Signal is linked as +15555550123.",
        "Docker container: openclaw-signal",
        "Docker volume: openclaw-signal",
        "Check it with: openclaw channels status --probe",
      ].join("\n"),
      "Signal is set up",
    );
    expect(prompts.note).not.toHaveBeenCalledWith(
      expect.stringContaining('signal-cli link -n "OpenClaw"'),
      "Signal next steps",
    );
    expect(prompts.note).not.toHaveBeenCalledWith(
      expect.stringContaining("Scan QR"),
      "Signal next steps",
    );
  });

  it("creates a Docker container when switching from an existing Signal server", async () => {
    const runner = vi.fn(async () => ({
      ok: true as const,
      account: "+15555550123",
      httpUrl: "http://127.0.0.1:19080",
      containerName: "openclaw-signal-new",
      volumeName: "openclaw-signal-new",
    }));
    setSignalContainerSetupRunnerForTest(runner);
    const prompts = createQueuedWizardPrompter({
      selectValues: ["container"],
      textValues: ["openclaw-signal-new", "19080"],
    });

    const result = await runSetupWizardConfigure({
      configure: configureSignalSetup,
      cfg: {
        channels: {
          signal: {
            enabled: true,
            account: "+15555550123",
            httpUrl: "http://stale-signal:8080",
            autoStart: false,
            apiMode: "auto",
          },
        },
      } as OpenClawConfig,
      prompter: prompts.prompter,
    });

    expect(runner).toHaveBeenCalledWith({
      containerName: "openclaw-signal-new",
      hostPort: 19080,
      image: "bbernhard/signal-cli-rest-api:0.100",
      prompter: prompts.prompter,
    });
    expect(result.cfg.channels?.signal).toMatchObject({
      account: "+15555550123",
      httpUrl: "http://127.0.0.1:19080",
      autoStart: false,
      apiMode: "container",
    });
  });

  it("keeps container setup classified when adding a named account", async () => {
    const runner = vi.fn(async () => ({
      ok: true as const,
      account: "+15555550124",
      httpUrl: "http://127.0.0.1:19080",
      containerName: "openclaw-signal-work",
      volumeName: "openclaw-signal-work",
    }));
    setSignalContainerSetupRunnerForTest(runner);
    const prompts = createQueuedWizardPrompter({
      selectValues: ["container"],
      textValues: ["openclaw-signal-work", "19080"],
    });

    const result = await runSetupWizardConfigure({
      configure: configureSignalSetup,
      cfg: {
        channels: {
          signal: {
            enabled: true,
            accounts: {
              default: {
                account: "+15555550123",
                cliPath: "/usr/local/bin/signal-cli",
                autoStart: true,
              },
            },
          },
        },
      } as OpenClawConfig,
      prompter: prompts.prompter,
      accountOverrides: { signal: "work" },
    });

    expect(result.cfg.channels?.signal?.apiMode).toBeUndefined();
    expect(result.cfg.channels?.signal?.accounts?.default).toMatchObject({
      account: "+15555550123",
      cliPath: "/usr/local/bin/signal-cli",
      autoStart: true,
    });
    expect(result.cfg.channels?.signal?.accounts?.work).toMatchObject({
      account: "+15555550124",
      httpUrl: "http://127.0.0.1:19080",
      autoStart: false,
      apiMode: "container",
    });
  });

  it("does not crash or save config when Signal Docker setup fails", async () => {
    const runner = vi.fn(async () => ({
      ok: false as const,
      error: "Docker is not available or the daemon is not running.",
    }));
    setSignalContainerSetupRunnerForTest(runner);
    const prompts = createQueuedWizardPrompter({
      selectValues: ["container"],
      textValues: ["openclaw-signal", "18080"],
    });

    const result = await runSetupWizardConfigure({
      configure: configureSignalSetup,
      prompter: prompts.prompter,
    });

    expect(runner).toHaveBeenCalledWith({
      containerName: "openclaw-signal",
      hostPort: 18080,
      image: "bbernhard/signal-cli-rest-api:0.100",
      prompter: prompts.prompter,
    });
    expect(result.cfg.channels?.signal).toBeUndefined();
    expect(result.setupApplied).toBe(false);
    expect(prompts.note).toHaveBeenCalledWith(
      [
        "Docker is not available or the daemon is not running.",
        "",
        "Signal setup was not saved. Start Docker or fix the Docker daemon, then run setup again.",
      ].join("\n"),
      "Signal container",
    );
    expect(prompts.note).not.toHaveBeenCalledWith(
      expect.stringContaining("Check it with: openclaw channels status --probe"),
      "Signal is set up",
    );
  });

  it("uses configured defaultAccount for omitted DM policy account context", () => {
    const cfg: OpenClawConfig = {
      channels: {
        signal: {
          defaultAccount: "work",
          dmPolicy: "disabled",
          allowFrom: ["+15555550123"],
          accounts: {
            work: {
              account: "+15555550999",
              dmPolicy: "allowlist",
            },
          },
        },
      },
    };

    expect(signalDmPolicy.getCurrent(cfg)).toBe("allowlist");
    expect(signalDmPolicy.resolveConfigKeys?.(cfg)).toEqual({
      policyKey: "channels.signal.accounts.work.dmPolicy",
      allowFromKey: "channels.signal.accounts.work.allowFrom",
    });

    const next = signalDmPolicy.setPolicy(cfg, "open");
    expect(next.channels?.signal?.dmPolicy).toBe("disabled");
    expect(next.channels?.signal?.allowFrom).toEqual(["+15555550123"]);
    expect(next.channels?.signal?.accounts?.work?.dmPolicy).toBe("open");
    expect(next.channels?.signal?.accounts?.work?.allowFrom).toEqual(["+15555550123", "*"]);
  });

  it('writes open policy state to the named account and stores inherited allowFrom with "*"', () => {
    const cfg: OpenClawConfig = {
      channels: {
        signal: {
          allowFrom: ["+15555550123"],
          accounts: {
            work: {
              account: "+15555550999",
            },
          },
        },
      },
    };

    const next = signalDmPolicy.setPolicy(cfg, "open", "work");

    expect(next.channels?.signal?.dmPolicy).toBeUndefined();
    expect(next.channels?.signal?.allowFrom).toEqual(["+15555550123"]);
    expect(next.channels?.signal?.accounts?.work?.dmPolicy).toBe("open");
    expect(next.channels?.signal?.accounts?.work?.allowFrom).toEqual(["+15555550123", "*"]);
  });
});
