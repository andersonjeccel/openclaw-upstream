// Signal plugin module implements probe behavior.
import type { BaseProbeResult } from "openclaw/plugin-sdk/channel-contract";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  detectSignalApiMode,
  type SignalApiMode,
  signalCheck,
  signalRpcRequest,
} from "./client-adapter.js";

export type SignalProbeReadiness =
  | "account_missing"
  | "unreachable"
  | "receive_unavailable"
  | "ready";

export type SignalProbe = BaseProbeResult & {
  status?: number | null;
  elapsedMs: number;
  version?: string | null;
  readiness: SignalProbeReadiness;
};

function parseSignalVersion(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (typeof value === "object" && value !== null) {
    const version = (value as { version?: unknown }).version;
    if (typeof version === "string" && version.trim()) {
      return version.trim();
    }
  }
  return null;
}

function classifyFailedSignalCheck(error: string | null | undefined): SignalProbeReadiness {
  return /\breceive\b/i.test(error ?? "") ? "receive_unavailable" : "unreachable";
}

async function resolveProbeApiMode(params: {
  baseUrl: string;
  timeoutMs: number;
  apiMode: SignalApiMode;
  account: string;
}): Promise<"native" | "container" | null> {
  if (params.apiMode === "native" || params.apiMode === "container") {
    return params.apiMode;
  }
  return await detectSignalApiMode(params.baseUrl, params.timeoutMs, {
    account: params.account,
    requireReceive: true,
  }).catch(() => null);
}

async function validateContainerProbeAccount(params: {
  baseUrl: string;
  timeoutMs: number;
  apiMode: SignalApiMode;
  account: string;
}): Promise<string | null> {
  const mode = await resolveProbeApiMode(params);
  if (mode !== "container") {
    return null;
  }
  const { validateSignalContainerLinkedAccount } = await import("./setup-container.js");
  const linked = await validateSignalContainerLinkedAccount({
    httpUrl: params.baseUrl,
    account: params.account,
    timeoutMs: params.timeoutMs,
  });
  return linked.ok ? null : linked.error;
}

export async function probeSignal(
  baseUrl: string,
  timeoutMs: number,
  options: { apiMode?: SignalApiMode; account?: string } = {},
): Promise<SignalProbe> {
  const started = Date.now();
  const result: SignalProbe = {
    ok: false,
    status: null,
    error: null,
    elapsedMs: 0,
    version: null,
    readiness: "unreachable",
  };
  const account = normalizeOptionalString(options.account);
  const apiMode = options.apiMode ?? "native";
  const check = await signalCheck(baseUrl, timeoutMs, {
    apiMode,
    account,
    requireReceive: Boolean(account),
  });
  if (!check.ok) {
    return {
      ...result,
      status: check.status ?? null,
      error: check.error ?? "unreachable",
      elapsedMs: Date.now() - started,
      readiness: classifyFailedSignalCheck(check.error),
    };
  }
  try {
    const version = await signalRpcRequest("version", undefined, {
      baseUrl,
      timeoutMs,
      apiMode,
    });
    result.version = parseSignalVersion(version);
  } catch (err) {
    result.error = formatErrorMessage(err);
  }
  if (!account) {
    return {
      ...result,
      ok: true,
      status: check.status ?? null,
      error: result.error ?? "Signal account is not configured",
      elapsedMs: Date.now() - started,
      readiness: "account_missing",
    };
  }
  const containerAccountError = await validateContainerProbeAccount({
    baseUrl,
    timeoutMs,
    apiMode,
    account,
  });
  if (containerAccountError) {
    return {
      ...result,
      status: check.status ?? null,
      error: containerAccountError,
      elapsedMs: Date.now() - started,
      readiness: "receive_unavailable",
    };
  }
  return {
    ...result,
    ok: true,
    status: check.status ?? null,
    elapsedMs: Date.now() - started,
    readiness: "ready",
  };
}
