// Signal plugin module implements setup core behavior.
import {
  createCliPathTextInput,
  createDelegatedSetupWizardProxy,
  createDelegatedTextInputShouldPrompt,
  createPatchedAccountSetupAdapter,
  createSetupInputPresenceValidator,
  DEFAULT_ACCOUNT_ID,
  mergeAllowFromEntries,
  parseSetupEntriesAllowingWildcard,
  patchChannelConfigForAccount,
  promptParsedAllowFromForAccount,
  setAccountAllowFromForChannel,
  setSetupChannelEnabled,
  type ChannelSetupAdapter,
  type ChannelSetupWizard,
  type ChannelSetupWizardTextInput,
  type OpenClawConfig,
  createSetupTranslator,
  type WizardPrompter,
} from "openclaw/plugin-sdk/setup-runtime";
import { formatCliCommand, formatDocsLink } from "openclaw/plugin-sdk/setup-tools";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeE164 } from "openclaw/plugin-sdk/text-utility-runtime";
import { resolveDefaultSignalAccountId, resolveSignalAccount } from "./accounts.js";
import type { SignalApiMode } from "./client-adapter.js";

const t = createSetupTranslator();

const channel = "signal" as const;
const MIN_E164_DIGITS = 5;
const MAX_E164_DIGITS = 15;
const DIGITS_ONLY = /^\d+$/;
const SIGNAL_SETUP_TRANSPORT_KEY = "signalTransport";
const SIGNAL_CONTAINER_SETUP_MODE_KEY = "signalContainerSetupMode";
const SIGNAL_SETUP_CANCELLED_KEY = "signalSetupCancelled";
const SIGNAL_SETUP_ORIGINAL_CHANNEL_KEY = "signalSetupOriginalChannel";
const SIGNAL_SETUP_ORIGINAL_CHANNEL_ABSENT = "__absent__";
const DEFAULT_SIGNAL_CONTAINER_NAME = "openclaw-signal";
const DEFAULT_SIGNAL_CONTAINER_PORT = 18080;
const DEFAULT_SIGNAL_CONTAINER_IMAGE = "bbernhard/signal-cli-rest-api:0.100";
const SIGNAL_STATUS_PROBE_COMMAND = formatCliCommand("openclaw channels status --probe");
const SIGNAL_PHONE_NUMBER_EXAMPLE = "+15555550123";

export type SignalSetupTransport = "native" | "external-native" | "container";
export type SignalContainerSetupMode = "existing" | "create";

export type SignalContainerSetupRunnerParams = {
  containerName: string;
  hostPort: number;
  image: string;
  prompter: WizardPrompter;
};

export type SignalContainerSetupRunnerResult =
  | {
      ok: true;
      account: string;
      httpUrl: string;
      containerName: string;
      volumeName: string;
      qrLink?: string;
    }
  | {
      ok: false;
      error: string;
    };

export type SignalContainerSetupRunner = (
  params: SignalContainerSetupRunnerParams,
) => Promise<SignalContainerSetupRunnerResult>;

export type SignalSetupServerProbeParams = {
  httpUrl: string;
  account: string;
  apiMode: SignalApiMode;
};

export type SignalSetupServerProbeResult =
  | {
      ok: true;
      version?: string | null;
    }
  | {
      ok: false;
      error: string;
    };

export type SignalSetupServerProbe = (
  params: SignalSetupServerProbeParams,
) => Promise<SignalSetupServerProbeResult>;

let signalContainerSetupRunnerForTest: SignalContainerSetupRunner | undefined;
let signalSetupServerProbeForTest: SignalSetupServerProbe | undefined;

export function setSignalContainerSetupRunnerForTest(
  runner: SignalContainerSetupRunner | undefined,
): void {
  signalContainerSetupRunnerForTest = runner;
}

export function setSignalSetupServerProbeForTest(probe: SignalSetupServerProbe | undefined): void {
  signalSetupServerProbeForTest = probe;
}

export function normalizeSignalAccountInput(value: string | null | undefined): string | null {
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

function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function parseSignalAllowFromEntries(raw: string): { entries: string[]; error?: string } {
  return parseSetupEntriesAllowingWildcard(raw, (entry) => {
    if (normalizeLowercaseStringOrEmpty(entry).startsWith("uuid:")) {
      const id = entry.slice("uuid:".length).trim();
      if (!id) {
        return { error: "Invalid uuid entry" };
      }
      return { value: `uuid:${id}` };
    }
    if (isUuidLike(entry)) {
      return { value: `uuid:${entry}` };
    }
    const normalized = normalizeSignalAccountInput(entry);
    if (!normalized) {
      return { error: `Invalid entry: ${entry}` };
    }
    return { value: normalized };
  });
}

function buildSignalSetupPatch(input: {
  signalNumber?: string;
  cliPath?: string;
  httpUrl?: string;
  httpHost?: string;
  httpPort?: string;
}) {
  const externalDaemonPatch = input.httpUrl ? { autoStart: false } : {};
  return {
    ...(input.signalNumber ? { account: input.signalNumber } : {}),
    ...(input.cliPath ? { cliPath: input.cliPath } : {}),
    ...(input.httpUrl ? { httpUrl: input.httpUrl } : {}),
    ...(input.httpHost ? { httpHost: input.httpHost } : {}),
    ...(input.httpPort ? { httpPort: Number(input.httpPort) } : {}),
    ...externalDaemonPatch,
  };
}

function serializeSignalSetupOriginalChannel(cfg: OpenClawConfig): string {
  const channelConfig = cfg.channels?.signal;
  return channelConfig === undefined
    ? SIGNAL_SETUP_ORIGINAL_CHANNEL_ABSENT
    : JSON.stringify(channelConfig);
}

function restoreSignalSetupOriginalChannel(params: {
  cfg: OpenClawConfig;
  credentialValues: Record<string, string | undefined>;
}): OpenClawConfig {
  const serialized = params.credentialValues[SIGNAL_SETUP_ORIGINAL_CHANNEL_KEY];
  if (!serialized) {
    return params.cfg;
  }
  const nextChannels = { ...params.cfg.channels };
  if (serialized === SIGNAL_SETUP_ORIGINAL_CHANNEL_ABSENT) {
    delete nextChannels.signal;
  } else {
    nextChannels.signal = JSON.parse(serialized);
  }
  const next = { ...params.cfg } as OpenClawConfig;
  if (Object.keys(nextChannels).length > 0) {
    next.channels = nextChannels as OpenClawConfig["channels"];
  } else {
    delete next.channels;
  }
  return next;
}

function resolveSignalSetupTransportFromConfig(params: {
  cfg: OpenClawConfig;
  accountId: string;
}): SignalSetupTransport {
  const account = resolveSignalAccount(params).config;
  if (account.apiMode === "container") {
    return "container";
  }
  if (normalizeOptionalString(account.httpUrl) || account.autoStart === false) {
    return "external-native";
  }
  return "native";
}

function resolveSignalSetupChoiceFromConfig(params: {
  cfg: OpenClawConfig;
  accountId: string;
}): SignalSetupTransport {
  const account = resolveSignalAccount(params).config;
  if (account.apiMode === "container") {
    return "container";
  }
  if (normalizeOptionalString(account.httpUrl) || account.autoStart === false) {
    return "external-native";
  }
  if (normalizeOptionalString(account.account)) {
    return "native";
  }
  if (
    !normalizeOptionalString(account.cliPath) &&
    !normalizeOptionalString(account.configPath) &&
    account.autoStart !== true
  ) {
    return "container";
  }
  return "native";
}

function resolveSignalSetupTransport(
  value: unknown,
  fallback: SignalSetupTransport,
): SignalSetupTransport {
  return value === "native" || value === "external-native" || value === "container"
    ? value
    : fallback;
}

function resolveSignalContainerSetupMode(
  value: unknown,
  fallback: SignalContainerSetupMode,
): SignalContainerSetupMode {
  return value === "existing" || value === "create" ? value : fallback;
}

function resolveSignalContainerSetupModeFromCredentialValues(params: {
  cfg: OpenClawConfig;
  accountId: string;
  credentialValues: Record<string, unknown>;
}): SignalContainerSetupMode {
  const existingHttpUrl = normalizeOptionalString(
    resolveSignalAccount({ cfg: params.cfg, accountId: params.accountId }).config.httpUrl,
  );
  return resolveSignalContainerSetupMode(
    params.credentialValues[SIGNAL_CONTAINER_SETUP_MODE_KEY],
    existingHttpUrl ? "existing" : "create",
  );
}

export function resolveSignalSetupTransportFromCredentialValues(params: {
  cfg: OpenClawConfig;
  accountId: string;
  credentialValues: Record<string, unknown>;
}): SignalSetupTransport {
  return resolveSignalSetupTransport(
    params.credentialValues[SIGNAL_SETUP_TRANSPORT_KEY],
    resolveSignalSetupTransportFromConfig(params),
  );
}

function parseSignalContainerPort(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const port = Number(trimmed);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    return null;
  }
  return port;
}

function validateSignalContainerName(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return "Required";
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(trimmed)) {
    return "Use letters, numbers, dots, underscores, or dashes.";
  }
  return undefined;
}

async function resolveSignalContainerSetupRunner(): Promise<SignalContainerSetupRunner> {
  if (signalContainerSetupRunnerForTest) {
    return signalContainerSetupRunnerForTest;
  }
  const { defaultSignalContainerSetupRunner } = await import("./setup-container.js");
  return defaultSignalContainerSetupRunner;
}

async function defaultSignalSetupServerProbe(
  params: SignalSetupServerProbeParams,
): Promise<SignalSetupServerProbeResult> {
  const { probeSignal } = await import("./probe.js");
  const probe = await probeSignal(params.httpUrl, 5_000, {
    account: params.account,
    apiMode: params.apiMode,
  });
  if (probe.ok) {
    const apiMode = await resolveSignalSetupProbeApiMode(params);
    if (apiMode === "container" && normalizeOptionalString(params.account)) {
      const { validateSignalContainerLinkedAccount } = await import("./setup-container.js");
      const account = await validateSignalContainerLinkedAccount({
        httpUrl: params.httpUrl,
        account: params.account,
        timeoutMs: 5_000,
      });
      if (!account.ok) {
        return account;
      }
    }
    return { ok: true, version: probe.version };
  }
  return {
    ok: false,
    error: probe.error ?? `Signal server was not ready (${probe.readiness})`,
  };
}

async function resolveSignalSetupProbeApiMode(
  params: SignalSetupServerProbeParams,
): Promise<"native" | "container"> {
  if (params.apiMode === "native" || params.apiMode === "container") {
    return params.apiMode;
  }
  const { detectSignalApiMode } = await import("./client-adapter.js");
  return detectSignalApiMode(params.httpUrl, 5_000, {
    account: params.account,
    requireReceive: Boolean(normalizeOptionalString(params.account)),
  });
}

function resolveSignalSetupServerProbe(): SignalSetupServerProbe {
  return signalSetupServerProbeForTest ?? defaultSignalSetupServerProbe;
}

async function promptReachableSignalServerUrl(params: {
  prompter: WizardPrompter;
  title: string;
  message: string;
  initialValue: string;
  placeholder: string;
  account: string;
  apiMode: SignalApiMode;
}): Promise<string | null> {
  while (true) {
    const httpUrl = normalizeOptionalString(
      await params.prompter.text({
        message: params.message,
        initialValue: params.initialValue,
        placeholder: params.placeholder,
        validate: (value) => (normalizeOptionalString(value) ? undefined : "Required"),
      }),
    );
    if (!httpUrl) {
      throw new Error("Signal server URL is required.");
    }

    const progress = params.prompter.progress("Testing Signal server URL");
    try {
      progress.update(`Testing ${httpUrl}`);
      const probe = await resolveSignalSetupServerProbe()({
        httpUrl,
        account: params.account,
        apiMode: params.apiMode,
      });
      if (probe.ok) {
        progress.stop("Signal server reachable");
        return httpUrl;
      }
      progress.stop();
      await params.prompter.note(
        [
          `OpenClaw could not reach a working Signal server at ${httpUrl}.`,
          `Error: ${probe.error}`,
          "",
          "Start or fix the Signal helper, then try this URL again. OpenClaw will not save this setup until the server check passes.",
        ].join("\n"),
        params.title,
      );
    } catch (error) {
      progress.stop();
      await params.prompter.note(
        [
          `OpenClaw could not check the Signal server at ${httpUrl}.`,
          `Error: ${String(error)}`,
          "",
          "Start or fix the Signal helper, then try this URL again. OpenClaw will not save this setup until the server check passes.",
        ].join("\n"),
        params.title,
      );
    }

    const retry = await params.prompter.confirm({
      message: "Try the Signal server URL again?",
      initialValue: true,
    });
    if (!retry) {
      return null;
    }
    params.initialValue = httpUrl;
  }
}

async function promptSignalAllowFrom(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  accountId?: string;
}): Promise<OpenClawConfig> {
  return promptParsedAllowFromForAccount({
    cfg: params.cfg,
    accountId: params.accountId,
    defaultAccountId: resolveDefaultSignalAccountId(params.cfg),
    prompter: params.prompter,
    noteTitle: t("wizard.signal.allowlistTitle"),
    noteLines: [
      t("wizard.signal.allowlistIntro"),
      "Use phone numbers in international format, or uuid:... if Signal only exposes a sender UUID.",
      "Use * only if you want to allow anyone.",
      "Examples:",
      `- ${SIGNAL_PHONE_NUMBER_EXAMPLE}`,
      "- uuid:123e4567-e89b-12d3-a456-426614174000",
      "- *",
      t("wizard.signal.multipleEntries"),
      `Docs: ${formatDocsLink("/signal", "signal")}`,
    ],
    message: t("wizard.signal.allowFromPrompt"),
    placeholder: `${SIGNAL_PHONE_NUMBER_EXAMPLE}, uuid:123e4567-e89b-12d3-a456-426614174000`,
    parseEntries: parseSignalAllowFromEntries,
    getExistingAllowFrom: ({ cfg, accountId }) =>
      resolveSignalAccount({ cfg, accountId }).config.allowFrom ?? [],
    applyAllowFrom: ({ cfg, accountId, allowFrom }) =>
      setAccountAllowFromForChannel({
        cfg,
        channel,
        accountId,
        allowFrom,
      }),
  });
}

export const signalDmPolicy = {
  label: "Signal",
  channel,
  policyKey: "channels.signal.dmPolicy",
  allowFromKey: "channels.signal.allowFrom",
  resolveConfigKeys: (cfg: OpenClawConfig, accountId?: string) =>
    (accountId ?? resolveDefaultSignalAccountId(cfg)) !== DEFAULT_ACCOUNT_ID
      ? {
          policyKey: `channels.signal.accounts.${accountId ?? resolveDefaultSignalAccountId(cfg)}.dmPolicy`,
          allowFromKey: `channels.signal.accounts.${accountId ?? resolveDefaultSignalAccountId(cfg)}.allowFrom`,
        }
      : {
          policyKey: "channels.signal.dmPolicy",
          allowFromKey: "channels.signal.allowFrom",
        },
  getCurrent: (cfg: OpenClawConfig, accountId?: string) =>
    resolveSignalAccount({ cfg, accountId: accountId ?? resolveDefaultSignalAccountId(cfg) }).config
      .dmPolicy ?? "pairing",
  setPolicy: (
    cfg: OpenClawConfig,
    policy: "pairing" | "allowlist" | "open" | "disabled",
    accountId?: string,
  ) =>
    patchChannelConfigForAccount({
      cfg,
      channel,
      accountId: accountId ?? resolveDefaultSignalAccountId(cfg),
      patch:
        policy === "open"
          ? {
              dmPolicy: "open",
              allowFrom: mergeAllowFromEntries(
                resolveSignalAccount({
                  cfg,
                  accountId: accountId ?? resolveDefaultSignalAccountId(cfg),
                }).config.allowFrom,
                ["*"],
              ),
            }
          : { dmPolicy: policy },
    }),
  promptAllowFrom: promptSignalAllowFrom,
};

function resolveSignalCliPath(params: {
  cfg: OpenClawConfig;
  accountId: string;
  credentialValues: Record<string, unknown>;
}) {
  if (resolveSignalSetupTransportFromCredentialValues(params) !== "native") {
    return undefined;
  }
  return (
    (typeof params.credentialValues.cliPath === "string"
      ? params.credentialValues.cliPath
      : undefined) ??
    resolveSignalAccount({ cfg: params.cfg, accountId: params.accountId }).config.cliPath ??
    "signal-cli"
  );
}

export function createSignalCliPathTextInput(
  shouldPrompt: NonNullable<ChannelSetupWizardTextInput["shouldPrompt"]>,
): ChannelSetupWizardTextInput {
  return createCliPathTextInput({
    inputKey: "cliPath",
    message: "signal-cli path",
    helpTitle: "signal-cli path",
    helpLines: [
      "This is the command OpenClaw runs for local signal-cli setup.",
      "Use the full path if it is not on PATH, for example /opt/homebrew/bin/signal-cli.",
    ],
    resolvePath: ({ cfg, accountId, credentialValues }) =>
      resolveSignalCliPath({ cfg, accountId, credentialValues }),
    shouldPrompt,
  });
}

export const signalNumberTextInput: ChannelSetupWizardTextInput = {
  inputKey: "signalNumber",
  message: t("wizard.signal.botNumberPrompt"),
  placeholder: SIGNAL_PHONE_NUMBER_EXAMPLE,
  helpTitle: "Signal phone number",
  helpLines: [
    "Enter the phone number for the Signal account OpenClaw will use.",
    `Use international format with + and country code, for example ${SIGNAL_PHONE_NUMBER_EXAMPLE}.`,
  ],
  currentValue: ({ cfg, accountId }) =>
    normalizeSignalAccountInput(resolveSignalAccount({ cfg, accountId }).config.account) ??
    undefined,
  shouldPrompt: ({ cfg, accountId, credentialValues }) =>
    resolveSignalSetupTransportFromCredentialValues({ cfg, accountId, credentialValues }) !==
      "container" ||
    resolveSignalContainerSetupModeFromCredentialValues({ cfg, accountId, credentialValues }) !==
      "create",
  keepPrompt: (value) => t("wizard.signal.accountKeep", { value }),
  validate: ({ value }) =>
    normalizeSignalAccountInput(value)
      ? undefined
      : `Enter a Signal phone number in international format, for example ${SIGNAL_PHONE_NUMBER_EXAMPLE}.`,
  normalizeValue: ({ value }) => normalizeSignalAccountInput(value) ?? value,
};

export const signalCompletionNote: NonNullable<ChannelSetupWizard["completionNote"]> = {
  title: t("wizard.signal.nextStepsTitle"),
  lines: [
    "Signal uses a real Signal account/device, not a Telegram-style token bot account.",
    "Use a dedicated Signal number for bot-like operation when possible.",
    t("wizard.signal.nextLinkDevice"),
    t("wizard.signal.nextScanQr"),
    `Then run: ${SIGNAL_STATUS_PROBE_COMMAND}`,
    `Docs: ${formatDocsLink("/signal", "signal")}`,
  ],
  shouldShow: (params) =>
    params.credentialValues[SIGNAL_SETUP_CANCELLED_KEY] !== "true" &&
    (resolveSignalSetupTransportFromCredentialValues(params) !== "container" ||
      resolveSignalContainerSetupModeFromCredentialValues(params) !== "create"),
};

export const signalSetupAdapter: ChannelSetupAdapter = createPatchedAccountSetupAdapter({
  channelKey: channel,
  validateInput: createSetupInputPresenceValidator({
    validate: ({ input }) => {
      if (
        !input.signalNumber &&
        !input.httpUrl &&
        !input.httpHost &&
        !input.httpPort &&
        !input.cliPath
      ) {
        return "Signal requires --signal-number or --http-url/--http-host/--http-port/--cli-path.";
      }
      return null;
    },
  }),
  buildPatch: (input) => buildSignalSetupPatch(input),
});

export async function prepareSignalSetupWizard(params: {
  cfg: OpenClawConfig;
  accountId: string;
  credentialValues: Record<string, string | undefined>;
  runtime: Parameters<NonNullable<ChannelSetupWizard["prepare"]>>[0]["runtime"];
  prompter: WizardPrompter;
  options?: Parameters<NonNullable<ChannelSetupWizard["prepare"]>>[0]["options"];
}) {
  await params.prompter.note(
    [
      "Signal uses a real Signal account with a phone number, not a bot token.",
      "",
      "It is usually best to give OpenClaw its own Signal account and phone number. That keeps OpenClaw messages separate from your personal Signal messages.",
    ].join("\n"),
    "Signal",
  );
  let initialValue = resolveSignalSetupChoiceFromConfig(params);
  const baseCredentialValues: Record<string, string | undefined> = {
    ...params.credentialValues,
    [SIGNAL_SETUP_ORIGINAL_CHANNEL_KEY]: serializeSignalSetupOriginalChannel(params.cfg),
  };

  while (true) {
    const initialTransport = initialValue;
    const transport = await params.prompter.select<SignalSetupTransport>({
      message: "How do you want to set up Signal for OpenClaw?",
      initialValue,
      options: [
        {
          value: "container",
          label: "Set up a Signal Docker container (Recommended)",
          hint: "Creates a local signal-cli-rest-api container and waits for linking.",
        },
        {
          value: "native",
          label: "Use local signal-cli",
          hint: "OpenClaw starts the local signal-cli daemon for this account.",
        },
        {
          value: "external-native",
          label: "Connect to an existing Signal server",
          hint: "OpenClaw stores the URL and auto-detects the server protocol.",
        },
      ],
    });

    const credentialValues: Record<string, string | undefined> = {
      ...baseCredentialValues,
      [SIGNAL_SETUP_TRANSPORT_KEY]: transport,
    };

    if (transport === "container") {
      const containerSetupMode =
        initialTransport === "container"
          ? resolveSignalContainerSetupModeFromCredentialValues({
              cfg: params.cfg,
              accountId: params.accountId,
              credentialValues,
            })
          : resolveSignalContainerSetupMode(
              credentialValues[SIGNAL_CONTAINER_SETUP_MODE_KEY],
              "create",
            );
      return {
        credentialValues: {
          ...credentialValues,
          [SIGNAL_CONTAINER_SETUP_MODE_KEY]: containerSetupMode,
        },
      };
    }

    if (transport !== "native" || !params.options?.allowSignalInstall) {
      return { credentialValues };
    }

    const currentCliPath =
      (typeof credentialValues.cliPath === "string" ? credentialValues.cliPath : undefined) ??
      resolveSignalAccount({ cfg: params.cfg, accountId: params.accountId }).config.cliPath ??
      "signal-cli";
    const { detectBinary } = await import("openclaw/plugin-sdk/setup-tools");
    const cliDetected = await detectBinary(currentCliPath);
    const wantsInstall = await params.prompter.confirm({
      message: cliDetected ? t("wizard.signal.reinstallPrompt") : t("wizard.signal.installPrompt"),
      initialValue: !cliDetected,
    });
    if (!wantsInstall) {
      return { credentialValues };
    }
    try {
      const { installSignalCli } = await import("./install-signal-cli.js");
      const result = await installSignalCli(params.runtime);
      if (result.ok && result.cliPath) {
        await params.prompter.note(`Installed signal-cli at ${result.cliPath}`, "Signal");
        return {
          credentialValues: {
            ...credentialValues,
            cliPath: result.cliPath,
          },
        };
      }
      if (!result.ok) {
        await params.prompter.note(result.error ?? "signal-cli install failed.", "Signal");
      }
    } catch (error) {
      await params.prompter.note(`signal-cli install failed: ${String(error)}`, "Signal");
    }
    initialValue = "native";
  }
}

export async function finalizeSignalSetupWizard(params: {
  cfg: OpenClawConfig;
  accountId: string;
  credentialValues: Record<string, string | undefined>;
  prompter: WizardPrompter;
}) {
  const transport = resolveSignalSetupTransportFromCredentialValues(params);
  let next = params.cfg;
  if (transport === "native") {
    const existingAccount = resolveSignalAccount({ cfg: next, accountId: params.accountId }).config;
    const existingConfigPath = normalizeOptionalString(existingAccount.configPath);
    const inheritedContainerMode = existingAccount.apiMode === "container";
    await params.prompter.note(
      [
        "Optional. This is the folder where signal-cli stores its local account data.",
        "Leave it blank unless you use a custom signal-cli data directory.",
        "Example: ~/.local/share/signal-cli",
      ].join("\n"),
      "signal-cli config path",
    );
    const configPath = normalizeOptionalString(
      await params.prompter.text({
        message: "signal-cli config path (optional)",
        initialValue: existingConfigPath,
        placeholder: "~/.local/share/signal-cli",
      }),
    );
    next = patchChannelConfigForAccount({
      cfg: next,
      channel,
      accountId: params.accountId,
      patch: {
        autoStart: true,
        ...(inheritedContainerMode ? { apiMode: "native" } : {}),
        httpUrl: undefined,
        httpHost: undefined,
        httpPort: undefined,
        configPath: configPath ?? undefined,
      },
    });
    return { cfg: next };
  }

  if (
    transport === "container" &&
    resolveSignalContainerSetupModeFromCredentialValues(params) === "create"
  ) {
    await params.prompter.note(
      [
        "OpenClaw will start a local Docker container for signal-cli-rest-api.",
        `Use the default name unless you already have a container named ${DEFAULT_SIGNAL_CONTAINER_NAME}.`,
      ].join("\n"),
      "Signal Docker container",
    );
    const containerName = (
      await params.prompter.text({
        message: "Signal Docker container name",
        initialValue: DEFAULT_SIGNAL_CONTAINER_NAME,
        placeholder: DEFAULT_SIGNAL_CONTAINER_NAME,
        validate: validateSignalContainerName,
      })
    ).trim();
    await params.prompter.note(
      [
        "Loopback means the Signal helper only listens on this computer.",
        `Use the default port ${DEFAULT_SIGNAL_CONTAINER_PORT} unless something else is already using it.`,
      ].join("\n"),
      "Signal Docker port",
    );
    const hostPortText = await params.prompter.text({
      message: "Signal Docker loopback port",
      initialValue: String(DEFAULT_SIGNAL_CONTAINER_PORT),
      placeholder: String(DEFAULT_SIGNAL_CONTAINER_PORT),
      validate: (value) => (parseSignalContainerPort(value) ? undefined : "Enter a port 1-65535"),
    });
    const hostPort = parseSignalContainerPort(hostPortText);
    if (!containerName || !hostPort) {
      return { cfg: next };
    }
    const setup = await (
      await resolveSignalContainerSetupRunner()
    )({
      containerName,
      hostPort,
      image: DEFAULT_SIGNAL_CONTAINER_IMAGE,
      prompter: params.prompter,
    });
    if (!setup.ok) {
      await params.prompter.note(
        [
          setup.error,
          "",
          "Signal setup was not saved. Start Docker or fix the Docker daemon, then run setup again.",
        ].join("\n"),
        "Signal container",
      );
      return {
        cfg: restoreSignalSetupOriginalChannel({
          cfg: next,
          credentialValues: params.credentialValues,
        }),
        credentialValues: { [SIGNAL_SETUP_CANCELLED_KEY]: "true" },
        setupApplied: false,
      };
    }
    await params.prompter.note(
      [
        "Signal is set up.",
        `Signal is linked as ${setup.account}.`,
        `Docker container: ${setup.containerName}`,
        `Docker volume: ${setup.volumeName}`,
        `Check it with: ${SIGNAL_STATUS_PROBE_COMMAND}`,
      ].join("\n"),
      "Signal is set up",
    );
    next = patchChannelConfigForAccount({
      cfg: next,
      channel,
      accountId: params.accountId,
      patch: {
        account: setup.account,
        httpUrl: setup.httpUrl,
        autoStart: false,
        apiMode: "container",
      },
    });
    return { cfg: next };
  }

  await params.prompter.note(
    [
      "Use the HTTP URL for the Signal helper OpenClaw should talk to.",
      "For a local helper, this usually looks like http://127.0.0.1:8080.",
    ].join("\n"),
    transport === "container" ? "Signal Docker server URL" : "Signal server URL",
  );
  const resolvedAccount = resolveSignalAccount({ cfg: next, accountId: params.accountId });
  const httpUrl = await promptReachableSignalServerUrl({
    prompter: params.prompter,
    title: transport === "container" ? "Signal Docker server URL" : "Signal server URL",
    message: transport === "container" ? "Signal Docker server URL" : "Signal server URL",
    initialValue:
      normalizeOptionalString(resolvedAccount.config.httpUrl) ?? resolvedAccount.baseUrl,
    placeholder: "http://127.0.0.1:8080",
    account: resolvedAccount.config.account ?? "",
    apiMode: transport === "container" ? "container" : "auto",
  });
  if (!httpUrl) {
    await params.prompter.note(
      "Signal server URL was not saved. Start or fix the Signal helper, then run setup again.",
      "Signal server URL",
    );
    return {
      cfg: restoreSignalSetupOriginalChannel({
        cfg: next,
        credentialValues: params.credentialValues,
      }),
      credentialValues: { [SIGNAL_SETUP_CANCELLED_KEY]: "true" },
      setupApplied: false,
    };
  }
  next = patchChannelConfigForAccount({
    cfg: next,
    channel,
    accountId: params.accountId,
    patch: {
      httpUrl,
      autoStart: false,
      apiMode: transport === "container" ? "container" : "auto",
    },
  });
  return { cfg: next };
}

export function createSignalSetupWizardProxy(loadWizard: () => Promise<ChannelSetupWizard>) {
  return createDelegatedSetupWizardProxy({
    channel,
    loadWizard,
    status: {
      configuredLabel: t("wizard.channels.statusConfigured"),
      unconfiguredLabel: t("wizard.channels.statusNeedsSetup"),
      configuredHint: t("wizard.channels.statusSignalCliFound"),
      unconfiguredHint: t("wizard.channels.statusSignalCliMissing"),
      configuredScore: 1,
      unconfiguredScore: 0,
    },
    delegatePrepare: true,
    delegateFinalize: true,
    credentials: [],
    textInputs: [
      createSignalCliPathTextInput(
        createDelegatedTextInputShouldPrompt({
          loadWizard,
          inputKey: "cliPath",
        }),
      ),
      signalNumberTextInput,
    ],
    completionNote: signalCompletionNote,
    dmPolicy: signalDmPolicy,
    disable: (cfg: OpenClawConfig) => setSetupChannelEnabled(cfg, channel, false),
  });
}
