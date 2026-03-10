#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { runInit } from "./init.js";
import {
  buildEnvFileContents,
  copyDirIfExists,
  DEFAULT_BASE_DIR,
  ensureDockerAvailable,
  envFileFor,
  envFileFromInstanceDir,
  extraComposeFileFromInstanceDir,
  getObject,
  inheritAuthProfiles,
  instancesDirFor,
  loadInstanceEnv,
  mergeRecords,
  readJson5File,
  randomToken,
  resolveInstanceDirForRead,
  ROOT_DIR,
  runDockerCompose,
  sanitizeName,
  writeJsonFile,
  writeTextFile,
} from "./shared.js";

const program = new Command();
program.name("docker-mu").description("OPENCLAW MULTI USER Docker helpers");
program.option("--base-dir <path>", "Root directory for all instances", DEFAULT_BASE_DIR);

function resolveBaseDir() {
  return String(program.opts<{ baseDir: string }>().baseDir || DEFAULT_BASE_DIR);
}

async function runPassthrough(command: string, args: string[]) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      env: process.env,
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code && code !== 0) {
        reject(new Error(`${command} exited with code ${code}`));
        return;
      }
      resolve();
    });
  });
}

async function runLocalSetup() {
  try {
    await runPassthrough("openclaw", ["setup", "--wizard"]);
    return;
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("ENOENT")) {
      throw error;
    }
  }

  await runPassthrough(process.execPath, [
    "--import",
    "tsx",
    path.join(ROOT_DIR, "src/index.ts"),
    "setup",
    "--wizard",
  ]);
}

function syncInstanceConfig(params: {
  sourceConfig: Record<string, unknown>;
  targetConfig: Record<string, unknown>;
  env: Awaited<ReturnType<typeof loadInstanceEnv>>;
}) {
  const next = mergeRecords(params.targetConfig, params.sourceConfig);

  const targetAgents = getObject(params.targetConfig.agents);
  const targetAgentDefaults = getObject(targetAgents.defaults);
  const nextAgents = getObject(next.agents);
  const nextAgentDefaults = getObject(nextAgents.defaults);
  if (typeof targetAgentDefaults.workspace === "string" && targetAgentDefaults.workspace.trim()) {
    nextAgentDefaults.workspace = targetAgentDefaults.workspace;
  } else {
    delete nextAgentDefaults.workspace;
  }
  next.agents = {
    ...nextAgents,
    defaults: nextAgentDefaults,
  };
  if (Array.isArray(targetAgents.list)) {
    (next.agents as Record<string, unknown>).list = [...targetAgents.list];
  } else {
    delete (next.agents as Record<string, unknown>).list;
  }

  const targetPlugins = getObject(params.targetConfig.plugins);
  const targetPluginLoad = getObject(targetPlugins.load);
  const nextPlugins = getObject(next.plugins);
  const nextPluginLoad = getObject(nextPlugins.load);
  if (Array.isArray(targetPluginLoad.paths)) {
    nextPluginLoad.paths = [...targetPluginLoad.paths];
  } else {
    delete nextPluginLoad.paths;
  }
  next.plugins = {
    ...nextPlugins,
    load: nextPluginLoad,
  };

  const nextSession = getObject(next.session);
  const targetSession = getObject(params.targetConfig.session);
  next.session = {
    ...nextSession,
    dmScope:
      typeof targetSession.dmScope === "string" && targetSession.dmScope.trim()
        ? targetSession.dmScope
        : "per-channel-peer",
  };

  const nextGateway = getObject(next.gateway);
  const targetGateway = getObject(params.targetConfig.gateway);
  const targetControlUi = getObject(targetGateway.controlUi);
  const allowLanAccess = Array.isArray(targetControlUi.allowedOrigins)
    ? targetControlUi.allowedOrigins.some((value) => value === "*")
    : false;
  next.gateway = {
    ...nextGateway,
    mode:
      typeof targetGateway.mode === "string" && targetGateway.mode.trim()
        ? targetGateway.mode
        : "local",
    port: Number.parseInt(params.env.OPENCLAW_GATEWAY_PORT, 10),
    bind: params.env.OPENCLAW_GATEWAY_BIND,
  };
  delete (next.gateway as Record<string, unknown>).remote;
  (next.gateway as Record<string, unknown>).auth = {
    ...getObject(nextGateway.auth),
    token: params.env.OPENCLAW_GATEWAY_TOKEN,
  };
  (next.gateway as Record<string, unknown>).controlUi = {
    ...getObject(nextGateway.controlUi),
    dangerouslyDisableDeviceAuth: targetControlUi.dangerouslyDisableDeviceAuth === true,
    allowedOrigins: allowLanAccess
      ? ["*"]
      : [
          `http://localhost:${params.env.OPENCLAW_GATEWAY_PORT}`,
          `http://127.0.0.1:${params.env.OPENCLAW_GATEWAY_PORT}`,
        ],
  };

  if (params.env.OPENCLAW_SHARED_SKILLS_DIR) {
    const nextSkills = getObject(next.skills);
    const nextLoad = getObject(nextSkills.load);
    const extraDirs = new Set(
      Array.isArray(nextLoad.extraDirs)
        ? nextLoad.extraDirs.filter(
            (value): value is string => typeof value === "string" && value.trim(),
          )
        : [],
    );
    extraDirs.add(params.env.OPENCLAW_SHARED_SKILLS_MOUNT);
    next.skills = {
      ...nextSkills,
      load: {
        ...nextLoad,
        extraDirs: [...extraDirs],
      },
    };
  }

  return next;
}

async function withInstance(
  instanceRaw: string,
  run: (params: {
    instance: string;
    baseDir: string;
    envFile: string;
    extraComposeFile?: string;
    env: Awaited<ReturnType<typeof loadInstanceEnv>>;
  }) => Promise<void>,
) {
  const baseDir = resolveBaseDir();
  const instance = sanitizeName(instanceRaw);
  const instanceDir = await resolveInstanceDirForRead(baseDir, instance);
  const envFile = envFileFromInstanceDir(instanceDir);
  const env = await loadInstanceEnv(baseDir, instance);
  const extraComposeFile = env.OPENCLAW_SHARED_SKILLS_DIR
    ? extraComposeFileFromInstanceDir(instanceDir)
    : undefined;
  await run({ instance, baseDir, envFile, extraComposeFile, env });
}

program
  .command("init")
  .description("Create per-instance directories and config")
  .argument("[instance]", "Instance name")
  .option("--gateway-port <port>")
  .option("--bridge-port <port>")
  .option("--bind <mode>")
  .option("--allow-lan-access")
  .option("--no-allow-lan-access")
  .option("--approve-device")
  .option("--no-approve-device")
  .option("--image <ref>")
  .option("--token <token>")
  .option("--config-dir <path>")
  .option("--workspace-dir <path>")
  .option("--project-name <name>")
  .option("--shared-skills-dir <path>")
  .option("--shared-skills-mount <path>")
  .option("--auth-choice <choice>")
  .option("--inherit-auth")
  .option("--inherit-auth-from <path>")
  .option("--inherit-models")
  .option("--inherit-web-search")
  .option("--inherit-managed-skills")
  .option("--openai-api-key <key>")
  .option("--anthropic-api-key <key>")
  .option("--setup-token <token>")
  .option("--force")
  .action(async (instance, opts) => {
    await runInit({
      instance,
      baseDir: resolveBaseDir(),
      gatewayPort: opts.gatewayPort,
      bridgePort: opts.bridgePort,
      bind: opts.bind,
      allowLanAccess: opts.allowLanAccess,
      approveDevice: opts.approveDevice,
      image: opts.image,
      token: opts.token,
      configDir: opts.configDir,
      workspaceDir: opts.workspaceDir,
      projectName: opts.projectName,
      sharedSkillsDir: opts.sharedSkillsDir,
      sharedSkillsMount: opts.sharedSkillsMount,
      authChoice: opts.authChoice,
      force: Boolean(opts.force),
      inheritAuth: Boolean(opts.inheritAuth),
      inheritAuthFrom: opts.inheritAuthFrom,
      inheritModels: Boolean(opts.inheritModels),
      inheritWebSearch: Boolean(opts.inheritWebSearch),
      inheritManagedSkills: Boolean(opts.inheritManagedSkills),
      openaiApiKey: opts.openaiApiKey,
      anthropicApiKey: opts.anthropicApiKey,
      setupToken: opts.setupToken,
    });
  });

program
  .command("local")
  .description("Run local openclaw setup on this machine")
  .action(async () => {
    await runLocalSetup();
  });

for (const command of ["start", "stop", "restart"] as const) {
  program
    .command(command)
    .description(`${command} an instance`)
    .argument("<instance>")
    .action(async (instance) => {
      ensureDockerAvailable();
      await withInstance(instance, async ({ envFile, extraComposeFile, env }) => {
        if (command === "restart") {
          await runDockerCompose(envFile, env.OPENCLAW_PROJECT_NAME, extraComposeFile, ["down"]);
          await runDockerCompose(envFile, env.OPENCLAW_PROJECT_NAME, extraComposeFile, [
            "up",
            "-d",
          ]);
          console.log("");
          console.log("Dashboard:");
          console.log(`http://127.0.0.1:${env.OPENCLAW_GATEWAY_PORT}/`);
          console.log("");
          console.log("Dashboard URL:");
          console.log(
            `http://127.0.0.1:${env.OPENCLAW_GATEWAY_PORT}/#token=${env.OPENCLAW_GATEWAY_TOKEN}`,
          );
          console.log("");
          console.log("Token:");
          console.log(env.OPENCLAW_GATEWAY_TOKEN);
          return;
        }
        await runDockerCompose(envFile, env.OPENCLAW_PROJECT_NAME, extraComposeFile, [
          command === "start" ? "up" : "down",
          ...(command === "start" ? ["-d"] : []),
        ]);
        if (command === "start") {
          console.log("");
          console.log("Dashboard:");
          console.log(`http://127.0.0.1:${env.OPENCLAW_GATEWAY_PORT}/`);
          console.log("");
          console.log("Dashboard URL:");
          console.log(
            `http://127.0.0.1:${env.OPENCLAW_GATEWAY_PORT}/#token=${env.OPENCLAW_GATEWAY_TOKEN}`,
          );
          console.log("");
          console.log("Token:");
          console.log(env.OPENCLAW_GATEWAY_TOKEN);
        }
      });
    });
}

program
  .command("rotate-token")
  .description("Rotate the gateway token for an instance and restart it")
  .argument("<instance>")
  .action(async (instance) => {
    ensureDockerAvailable();
    await withInstance(instance, async ({ envFile, extraComposeFile, env }) => {
      const nextToken = randomToken();
      const nextEnv = {
        ...env,
        OPENCLAW_GATEWAY_TOKEN: nextToken,
      };
      await writeTextFile(envFile, buildEnvFileContents(nextEnv));

      const configPath = path.join(env.OPENCLAW_CONFIG_DIR, "openclaw.json");
      const currentConfig = (await readJson5File<Record<string, unknown>>(configPath)) ?? {};
      const currentGateway = getObject(currentConfig.gateway);
      await writeJsonFile(configPath, {
        ...currentConfig,
        gateway: {
          ...currentGateway,
          auth: {
            ...getObject(currentGateway.auth),
            token: nextToken,
          },
        },
      });

      await runDockerCompose(envFile, env.OPENCLAW_PROJECT_NAME, extraComposeFile, ["down"]);
      await runDockerCompose(envFile, env.OPENCLAW_PROJECT_NAME, extraComposeFile, ["up", "-d"]);

      console.log("");
      console.log("Rotated gateway token.");
      console.log("");
      console.log("Dashboard:");
      console.log(`http://127.0.0.1:${env.OPENCLAW_GATEWAY_PORT}/`);
      console.log("");
      console.log("Dashboard URL:");
      console.log(`http://127.0.0.1:${env.OPENCLAW_GATEWAY_PORT}/#token=${nextToken}`);
      console.log("");
      console.log("Token:");
      console.log(nextToken);
    });
  });

program
  .command("status")
  .description("Show compose status and configured ports")
  .argument("<instance>")
  .action(async (instance) => {
    ensureDockerAvailable();
    await withInstance(instance, async ({ envFile, extraComposeFile, env }) => {
      console.log(`instance: ${env.OPENCLAW_INSTANCE_NAME}`);
      console.log(`project: ${env.OPENCLAW_PROJECT_NAME}`);
      console.log(`config: ${env.OPENCLAW_CONFIG_DIR}`);
      console.log(`workspace: ${env.OPENCLAW_WORKSPACE_DIR}`);
      console.log(`gateway: http://127.0.0.1:${env.OPENCLAW_GATEWAY_PORT}/`);
      console.log(`bridge:  http://127.0.0.1:${env.OPENCLAW_BRIDGE_PORT}/`);
      console.log("");
      await runDockerCompose(envFile, env.OPENCLAW_PROJECT_NAME, extraComposeFile, ["ps"]);
    });
  });

program
  .command("logs")
  .description("Tail logs for the instance")
  .argument("<instance>")
  .argument("[composeArgs...]", "Extra docker compose logs args")
  .allowUnknownOption(true)
  .action(async (instance, composeArgs) => {
    ensureDockerAvailable();
    await withInstance(instance, async ({ envFile, extraComposeFile, env }) => {
      await runDockerCompose(
        envFile,
        env.OPENCLAW_PROJECT_NAME,
        extraComposeFile,
        composeArgs.length > 0 ? ["logs", ...composeArgs] : ["logs", "-f", "openclaw-gateway"],
      );
    });
  });

program
  .command("run")
  .description("Run a one-off openclaw CLI command in the instance network namespace")
  .argument("<instance>")
  .argument("<openclawArgs...>", "OpenClaw CLI args to run inside the instance")
  .allowUnknownOption(true)
  .action(async (instance, openclawArgs) => {
    ensureDockerAvailable();
    await withInstance(instance, async ({ envFile, extraComposeFile, env }) => {
      await runDockerCompose(envFile, env.OPENCLAW_PROJECT_NAME, extraComposeFile, [
        "run",
        "--rm",
        "openclaw-cli",
        ...openclawArgs,
      ]);
    });
  });

program
  .command("auth")
  .description("Run onboarding for the saved auth choice")
  .argument("<instance>")
  .action(async (instance) => {
    ensureDockerAvailable();
    await withInstance(instance, async ({ envFile, extraComposeFile, env }) => {
      if (env.OPENCLAW_INIT_AUTH_CHOICE === "skip") {
        console.log(`No extra auth onboarding needed for ${env.OPENCLAW_INSTANCE_NAME}.`);
        return;
      }
      const base = ["run", "--rm"];
      if (env.OPENCLAW_INIT_AUTH_CHOICE === "openai-api-key") {
        if (!env.OPENAI_API_KEY) {
          throw new Error(`OPENAI_API_KEY is empty in ${envFile}.`);
        }
        await runDockerCompose(envFile, env.OPENCLAW_PROJECT_NAME, extraComposeFile, [
          ...base,
          "-e",
          `OPENAI_API_KEY=${env.OPENAI_API_KEY}`,
          "openclaw-cli",
          "onboard",
          "--non-interactive",
          "--accept-risk",
          "--auth-choice",
          "openai-api-key",
          "--openai-api-key",
          env.OPENAI_API_KEY,
          "--secret-input-mode",
          "plaintext",
          "--skip-channels",
          "--skip-skills",
          "--skip-search",
          "--skip-ui",
        ]);
        return;
      }
      if (env.OPENCLAW_INIT_AUTH_CHOICE === "apiKey") {
        if (!env.ANTHROPIC_API_KEY) {
          throw new Error(`ANTHROPIC_API_KEY is empty in ${envFile}.`);
        }
        await runDockerCompose(envFile, env.OPENCLAW_PROJECT_NAME, extraComposeFile, [
          ...base,
          "-e",
          `ANTHROPIC_API_KEY=${env.ANTHROPIC_API_KEY}`,
          "openclaw-cli",
          "onboard",
          "--non-interactive",
          "--accept-risk",
          "--auth-choice",
          "apiKey",
          "--anthropic-api-key",
          env.ANTHROPIC_API_KEY,
          "--secret-input-mode",
          "plaintext",
          "--skip-channels",
          "--skip-skills",
          "--skip-search",
          "--skip-ui",
        ]);
        return;
      }
      await runDockerCompose(envFile, env.OPENCLAW_PROJECT_NAME, extraComposeFile, [
        ...base,
        "openclaw-cli",
        "onboard",
        "--auth-choice",
        env.OPENCLAW_INIT_AUTH_CHOICE,
      ]);
    });
  });

program
  .command("sync")
  .description("Sync local ~/.openclaw config into an instance")
  .argument("<instance>")
  .option("--from <path>", "Local source state directory", path.join(os.homedir(), ".openclaw"))
  .action(async (instance, opts) => {
    await withInstance(instance, async ({ env }) => {
      const sourceDir = path.resolve(String(opts.from || path.join(os.homedir(), ".openclaw")));
      const sourceConfigPath = path.join(sourceDir, "openclaw.json");
      const targetConfigPath = path.join(env.OPENCLAW_CONFIG_DIR, "openclaw.json");
      const sourceConfig = (await readJson5File<Record<string, unknown>>(sourceConfigPath)) ?? {};
      const targetConfig = (await readJson5File<Record<string, unknown>>(targetConfigPath)) ?? {};
      const nextConfig = syncInstanceConfig({ sourceConfig, targetConfig, env });

      await writeJsonFile(targetConfigPath, nextConfig);
      await inheritAuthProfiles(sourceDir, env.OPENCLAW_CONFIG_DIR);
      await copyDirIfExists(
        path.join(sourceDir, "skills"),
        path.join(env.OPENCLAW_CONFIG_DIR, "skills"),
      );

      console.log(`Synced local config into ${env.OPENCLAW_INSTANCE_NAME}.`);
      console.log(`  source: ${sourceDir}`);
      console.log(`  config: ${targetConfigPath}`);
      console.log(`  auth: ${path.join(env.OPENCLAW_CONFIG_DIR, "agents/main/agent")}`);
      console.log(`  skills: ${path.join(env.OPENCLAW_CONFIG_DIR, "skills")}`);
      console.log("");
      console.log("If the instance is already running, restart it to apply updated config:");
      console.log(`  pnpm docker:mu -- restart ${env.OPENCLAW_INSTANCE_NAME}`);
    });
  });

program
  .command("approve-device")
  .description("Approve all pending operator device pairing requests")
  .argument("<instance>")
  .action(async (instance) => {
    ensureDockerAvailable();
    await withInstance(instance, async ({ envFile, extraComposeFile, env }) => {
      const configPath = path.join(env.OPENCLAW_CONFIG_DIR, "openclaw.json");
      const currentConfig = (await readJson5File<Record<string, unknown>>(configPath)) ?? {};
      const controlUi = getObject(getObject(getObject(currentConfig).gateway).controlUi);
      if (controlUi.dangerouslyDisableDeviceAuth === true) {
        console.log(
          `Device auth is disabled for ${env.OPENCLAW_INSTANCE_NAME}; approve-device is not needed.`,
        );
        return;
      }
      const result = await runDockerCompose(
        envFile,
        env.OPENCLAW_PROJECT_NAME,
        extraComposeFile,
        ["run", "--rm", "openclaw-cli", "devices", "list", "--json"],
        { stdio: "pipe" },
      );
      const list = JSON.parse(result.stdout || "{}") as {
        pending?: Array<{ requestId?: string; role?: string }>;
      };
      const requestIds = (list.pending ?? [])
        .filter((item) => item.role?.trim() === "operator" && item.requestId?.trim())
        .map((item) => item.requestId!.trim());
      if (requestIds.length === 0) {
        console.log(
          `No pending operator device pairing requests for ${env.OPENCLAW_INSTANCE_NAME}.`,
        );
        return;
      }
      for (const requestId of requestIds) {
        await runDockerCompose(envFile, env.OPENCLAW_PROJECT_NAME, extraComposeFile, [
          "run",
          "--rm",
          "openclaw-cli",
          "devices",
          "approve",
          requestId,
        ]);
      }
      console.log(
        `Approved ${requestIds.length} pending operator device request(s) for ${env.OPENCLAW_INSTANCE_NAME}.`,
      );
    });
  });

program
  .command("list")
  .description("List instances under the base directory")
  .action(async () => {
    const baseDir = resolveBaseDir();
    const instancesDir = instancesDirFor(baseDir);
    try {
      const entries = await fs.readdir(instancesDir, { withFileTypes: true });
      const names: string[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        const envFile = envFileFor(baseDir, entry.name);
        const exists = await fs
          .access(envFile)
          .then(() => true)
          .catch(() => false);
        if (exists) {
          names.push(entry.name);
        }
      }
      if (names.length > 0) {
        console.log(names.join("\n"));
        return;
      }
    } catch {}
    try {
      const entries = await fs.readdir(baseDir, { withFileTypes: true });
      const names: string[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name === "instances") {
          continue;
        }
        const envFile = envFileFor(baseDir, entry.name);
        const legacyEnvFile = path.join(baseDir, entry.name, ".env");
        const exists = await fs
          .access(envFile)
          .then(() => true)
          .catch(
            async () =>
              await fs
                .access(legacyEnvFile)
                .then(() => true)
                .catch(() => false),
          );
        if (exists) {
          names.push(entry.name);
        }
      }
      if (names.length > 0) {
        console.log(names.join("\n"));
        return;
      }
    } catch {}
    console.log(`No instances under ${instancesDir}`);
  });

program
  .command("print-env")
  .description("Print the generated env file path and contents")
  .argument("<instance>")
  .action(async (instance) => {
    const baseDir = resolveBaseDir();
    const instanceDir = await resolveInstanceDirForRead(baseDir, sanitizeName(instance));
    const envFile = envFileFromInstanceDir(instanceDir);
    console.log(envFile);
    console.log("");
    console.log(await fs.readFile(envFile, "utf-8"));
  });

const argv =
  process.argv[2] === "--"
    ? [process.argv[0], process.argv[1], ...process.argv.slice(3)]
    : process.argv;
await program.parseAsync(argv);
