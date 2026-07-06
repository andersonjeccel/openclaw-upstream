// Signal plugin module implements Docker container setup behavior.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveFetch } from "openclaw/plugin-sdk/fetch-runtime";
import {
  readProviderJsonResponse,
  readProviderTextResponse,
} from "openclaw/plugin-sdk/provider-http";
import { renderQrTerminal } from "openclaw/plugin-sdk/qr-terminal-runtime";
import type { WizardPrompter } from "openclaw/plugin-sdk/setup-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeE164 } from "openclaw/plugin-sdk/text-utility-runtime";
import type {
  SignalContainerSetupRunnerParams,
  SignalContainerSetupRunnerResult,
} from "./setup-core.js";

const SIGNAL_CONTAINER_READY_TIMEOUT_MS = 60_000;
const SIGNAL_CONTAINER_LINK_TIMEOUT_MS = 180_000;
const MIN_E164_DIGITS = 5;
const MAX_E164_DIGITS = 15;
const DIGITS_ONLY = /^\d+$/;

const execFileAsync = promisify(execFile);

function normalizeSignalContainerAccountInput(value: string | null | undefined): string | null {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return null;
  }
  const normalized = normalizeE164(trimmed);
  const digits = normalized.slice(1);
  if (!DIGITS_ONLY.test(digits)) {
    return null;
  }
  if (digits.length < MIN_E164_DIGITS || digits.length > MAX_E164_DIGITS) {
    return null;
  }
  return `+${digits}`;
}

async function runDocker(
  args: string[],
  timeoutMs: number,
): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  try {
    const result = (await execFileAsync("docker", args, {
      timeout: timeoutMs,
      windowsHide: true,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    })) as { stdout: string; stderr: string };
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const maybe = error as {
      code?: unknown;
      stdout?: unknown;
      stderr?: unknown;
      message?: unknown;
    };
    const code = typeof maybe.code === "number" ? maybe.code : 1;
    const stderr =
      typeof maybe.stderr === "string"
        ? maybe.stderr
        : typeof maybe.message === "string"
          ? maybe.message
          : String(error);
    return {
      code,
      stdout: typeof maybe.stdout === "string" ? maybe.stdout : "",
      stderr,
    };
  }
}

function normalizeSignalContainerBaseUrl(hostPort: number): string {
  return `http://127.0.0.1:${hostPort}`;
}

function normalizeSignalContainerHttpUrl(url: string): string {
  const trimmed = url.trim();
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  const parsed = new URL(withProtocol);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Signal container URL unsupported protocol: ${parsed.protocol}`);
  }
  const pathname = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "");
  return `${parsed.protocol}//${parsed.host}${pathname}`;
}

export function buildSignalContainerRunArgs(params: {
  containerName: string;
  hostPort: number;
  volumeName: string;
  image: string;
}): string[] {
  return [
    "run",
    "-d",
    "--name",
    params.containerName,
    "--restart",
    "unless-stopped",
    "-e",
    "MODE=json-rpc",
    "-p",
    `127.0.0.1:${params.hostPort}:8080`,
    "-v",
    `${params.volumeName}:/home/.local/share/signal-cli`,
    params.image,
  ];
}

function withManagedContainerNotice(
  result: { ok: false; error: string },
  containerName: string,
): { ok: false; error: string } {
  return {
    ok: false,
    error: [
      result.error,
      "",
      `OpenClaw already created or started Docker container ${containerName}.`,
      "Run setup again to reuse it, or remove it with:",
      `docker rm -f ${containerName}`,
    ].join("\n"),
  };
}

async function fetchSignalContainerJson(params: {
  httpUrl: string;
  path: string;
  timeoutMs: number;
}): Promise<{ ok: true; value: unknown } | { ok: false; status?: number; error: string }> {
  const fetchImpl = resolveFetch();
  if (!fetchImpl) {
    return { ok: false, error: "fetch is not available" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    const res = await fetchImpl(
      `${normalizeSignalContainerHttpUrl(params.httpUrl)}${params.path}`,
      {
        method: "GET",
        signal: controller.signal,
      },
    );
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    }
    return { ok: true, value: await readProviderJsonResponse<unknown>(res, "Signal setup") };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchSignalContainerText(params: {
  httpUrl: string;
  path: string;
  timeoutMs: number;
}): Promise<{ ok: true; value: string } | { ok: false; status?: number; error: string }> {
  const fetchImpl = resolveFetch();
  if (!fetchImpl) {
    return { ok: false, error: "fetch is not available" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    const res = await fetchImpl(
      `${normalizeSignalContainerHttpUrl(params.httpUrl)}${params.path}`,
      {
        method: "GET",
        signal: controller.signal,
      },
    );
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    }
    return { ok: true, value: await readProviderTextResponse(res, "Signal setup") };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

function parseSignalContainerAccounts(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const accounts: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      return null;
    }
    const normalized = normalizeSignalContainerAccountInput(entry);
    if (normalized) {
      accounts.push(normalized);
    }
  }
  return accounts;
}

/** @internal Exported for testing. */
export function validateSignalContainerAbout(
  value: unknown,
): { ok: true } | { ok: false; error: string } {
  if (!value || typeof value !== "object") {
    return { ok: false, error: "Signal container about response was not an object" };
  }
  const mode = (value as Record<string, unknown>).mode;
  if (mode !== "json-rpc") {
    const found = typeof mode === "string" && mode.trim() ? mode.trim() : "unknown";
    return {
      ok: false,
      error:
        `Signal container must run in json-rpc mode for OpenClaw receive support (found ${found}). ` +
        "Recreate it with MODE=json-rpc or choose the existing server setup path.",
    };
  }
  return { ok: true };
}

function parseSignalContainerQrLink(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = normalizeOptionalString(value);
    if (!trimmed) {
      return null;
    }
    if (trimmed.startsWith("{")) {
      try {
        return parseSignalContainerQrLink(JSON.parse(trimmed));
      } catch {
        return null;
      }
    }
    return trimmed.startsWith("sgnl://") ? trimmed : null;
  }
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  return typeof record.device_link_uri === "string"
    ? (normalizeOptionalString(record.device_link_uri) ?? null)
    : null;
}

export async function renderSignalLinkedDeviceQr(link: string): Promise<string> {
  return await renderQrTerminal(link, { small: true });
}

export async function showSignalLinkedDeviceQrPrompt(params: {
  link: string;
  prompter: WizardPrompter;
}): Promise<void> {
  const qrTerminal = await renderSignalLinkedDeviceQr(params.link);
  await params.prompter.note(
    [
      "Open Signal on your phone.",
      "Go to linked devices, add a new linked device, then scan the QR code below.",
      "",
      "If the QR code is not visible, create a QR code from this link:",
      params.link,
    ].join("\n"),
    "Signal container",
  );
  if (params.prompter.plain) {
    await params.prompter.plain(qrTerminal);
  } else {
    await params.prompter.note(qrTerminal, "Signal QR");
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForSignalContainerAbout(httpUrl: string): Promise<
  | {
      ok: true;
    }
  | {
      ok: false;
      error: string;
    }
> {
  const startedAt = Date.now();
  let lastError = "not ready";
  while (Date.now() - startedAt < SIGNAL_CONTAINER_READY_TIMEOUT_MS) {
    const about = await fetchSignalContainerJson({
      httpUrl,
      path: "/v1/about",
      timeoutMs: 2_000,
    });
    if (about.ok) {
      const validation = validateSignalContainerAbout(about.value);
      if (!validation.ok) {
        return validation;
      }
      return { ok: true };
    }
    lastError = about.error;
    await sleep(1_000);
  }
  return { ok: false, error: `Signal container did not become ready: ${lastError}` };
}

async function readSignalContainerAccounts(
  httpUrl: string,
  timeoutMs = 5_000,
): Promise<
  | {
      ok: true;
      accounts: string[];
    }
  | {
      ok: false;
      error: string;
    }
> {
  const accountsRes = await fetchSignalContainerJson({
    httpUrl,
    path: "/v1/accounts",
    timeoutMs,
  });
  if (!accountsRes.ok) {
    return { ok: false, error: `Signal accounts check failed: ${accountsRes.error}` };
  }
  const accounts = parseSignalContainerAccounts(accountsRes.value);
  if (!accounts) {
    return { ok: false, error: "Signal accounts response was not a string array" };
  }
  return { ok: true, accounts };
}

export async function validateSignalContainerLinkedAccount(params: {
  httpUrl: string;
  account: string;
  timeoutMs?: number;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const account = normalizeSignalContainerAccountInput(params.account);
  if (!account) {
    return { ok: false, error: "Signal account is not a valid phone number" };
  }

  const accountsRes = await readSignalContainerAccounts(params.httpUrl, params.timeoutMs);
  if (!accountsRes.ok) {
    return accountsRes;
  }
  if (accountsRes.accounts.includes(account)) {
    return { ok: true };
  }
  if (accountsRes.accounts.length === 0) {
    return { ok: false, error: `Signal container has no linked accounts; expected ${account}.` };
  }
  return {
    ok: false,
    error: `Signal container does not list ${account}; linked accounts: ${accountsRes.accounts.join(", ")}.`,
  };
}

async function waitForSignalContainerAccount(params: {
  httpUrl: string;
  prompter: WizardPrompter;
}): Promise<
  | {
      ok: true;
      account: string;
    }
  | {
      ok: false;
      error: string;
    }
> {
  const startedAt = Date.now();
  let lastError = "no linked account yet";
  const progress = params.prompter.progress("Waiting for Signal linked device");
  try {
    while (Date.now() - startedAt < SIGNAL_CONTAINER_LINK_TIMEOUT_MS) {
      const accountsRes = await readSignalContainerAccounts(params.httpUrl);
      if (!accountsRes.ok) {
        lastError = accountsRes.error;
      } else if (accountsRes.accounts.length === 1) {
        return { ok: true, account: accountsRes.accounts[0] };
      } else if (accountsRes.accounts.length > 1) {
        const account = await params.prompter.select({
          message: "Signal account",
          options: accountsRes.accounts.map((value) => ({ value, label: value })),
          initialValue: accountsRes.accounts[0],
        });
        return { ok: true, account };
      }
      progress.update("Waiting for Signal to link the device...");
      await sleep(2_000);
    }
  } finally {
    progress.stop();
  }
  return { ok: false, error: `Timed out waiting for a linked Signal account: ${lastError}` };
}

/** @internal Exported for testing. */
export async function createSignalContainerQrLink(params: {
  httpUrl: string;
  containerName: string;
}): Promise<
  | {
      ok: true;
      qrLink: string;
    }
  | {
      ok: false;
      error: string;
    }
> {
  const deviceName = encodeURIComponent(`OpenClaw ${params.containerName}`);
  const qrRes = await fetchSignalContainerText({
    httpUrl: params.httpUrl,
    path: `/v1/qrcodelink/raw?device_name=${deviceName}`,
    timeoutMs: 10_000,
  });
  if (!qrRes.ok) {
    return { ok: false, error: `Signal QR link failed: ${qrRes.error}` };
  }
  const qrLink = parseSignalContainerQrLink(qrRes.value);
  if (!qrLink) {
    return { ok: false, error: "Signal QR link response did not include a device link URI" };
  }
  return { ok: true, qrLink };
}

export async function defaultSignalContainerSetupRunner(
  params: SignalContainerSetupRunnerParams,
): Promise<SignalContainerSetupRunnerResult> {
  const dockerVersion = await runDocker(["version", "--format", "{{.Server.Version}}"], 10_000);
  if (dockerVersion.code !== 0) {
    return {
      ok: false,
      error: `Docker is not available or the daemon is not running: ${dockerVersion.stderr.trim()}`,
    };
  }

  const volumeName = params.containerName;
  let managedContainerThisRun = false;
  const inspect = await runDocker(
    ["inspect", "-f", "{{.State.Running}}", params.containerName],
    10_000,
  );
  if (inspect.code === 0) {
    if (inspect.stdout.trim() !== "true") {
      const start = await runDocker(["start", params.containerName], 30_000);
      if (start.code !== 0) {
        return {
          ok: false,
          error: `Docker container ${params.containerName} exists but could not start: ${start.stderr.trim()}`,
        };
      }
      managedContainerThisRun = true;
    }
  } else {
    const run = await runDocker(
      buildSignalContainerRunArgs({
        containerName: params.containerName,
        hostPort: params.hostPort,
        volumeName,
        image: params.image,
      }),
      120_000,
    );
    if (run.code !== 0) {
      return {
        ok: false,
        error: `Docker could not create/start ${params.containerName}: ${run.stderr.trim()}`,
      };
    }
    managedContainerThisRun = true;
  }

  const httpUrl = normalizeSignalContainerBaseUrl(params.hostPort);
  const ready = await waitForSignalContainerAbout(httpUrl);
  if (!ready.ok) {
    return managedContainerThisRun
      ? withManagedContainerNotice(ready, params.containerName)
      : ready;
  }

  const initialAccounts = await readSignalContainerAccounts(httpUrl);
  if (!initialAccounts.ok) {
    return managedContainerThisRun
      ? withManagedContainerNotice(initialAccounts, params.containerName)
      : initialAccounts;
  }
  let qrLink: string | undefined;
  if (initialAccounts.accounts.length === 0) {
    const qr = await createSignalContainerQrLink({
      httpUrl,
      containerName: params.containerName,
    });
    if (!qr.ok) {
      return managedContainerThisRun ? withManagedContainerNotice(qr, params.containerName) : qr;
    }
    qrLink = qr.qrLink;
    await showSignalLinkedDeviceQrPrompt({ link: qrLink, prompter: params.prompter });
  }

  if (initialAccounts.accounts.length === 1) {
    return {
      ok: true,
      account: initialAccounts.accounts[0],
      httpUrl,
      containerName: params.containerName,
      volumeName,
      qrLink,
    };
  }
  if (initialAccounts.accounts.length > 1) {
    const account = await params.prompter.select({
      message: "Signal account",
      options: initialAccounts.accounts.map((value) => ({ value, label: value })),
      initialValue: initialAccounts.accounts[0],
    });
    return {
      ok: true,
      account,
      httpUrl,
      containerName: params.containerName,
      volumeName,
      qrLink,
    };
  }

  const linked = await waitForSignalContainerAccount({
    httpUrl,
    prompter: params.prompter,
  });
  if (!linked.ok) {
    return managedContainerThisRun
      ? withManagedContainerNotice(linked, params.containerName)
      : linked;
  }
  return {
    ok: true,
    account: linked.account,
    httpUrl,
    containerName: params.containerName,
    volumeName,
    qrLink,
  };
}
