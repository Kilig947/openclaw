import fs from "node:fs/promises";
import path from "node:path";
import { confirm, intro, note, select, text } from "@clack/prompts";
import type { BindMode, InstanceEnv } from "./shared.js";
import {
  DEFAULT_BASE_DIR,
  DEFAULT_BIND,
  DEFAULT_IMAGE,
  DEFAULT_SHARED_SKILLS_MOUNT,
  buildEnvFileContents,
  buildExtraComposeContents,
  buildMetadataYaml,
  clearInstanceSessions,
  ensureDir,
  envFileFor,
  extraComposeFileFor,
  fail,
  getObject,
  inheritAuthProfiles,
  instanceDirFor,
  mergeRecords,
  metadataFileFor,
  parsePort,
  pathExists,
  randomToken,
  readJson5File,
  resolveAuthChoice,
  sanitizeName,
  writeJsonFile,
  writeTextFile,
} from "./shared.js";

type InitOptions = {
  instance?: string;
  baseDir?: string;
  gatewayPort?: string;
  bridgePort?: string;
  bind?: string;
  allowLanAccess?: boolean;
  approveDevice?: boolean;
  disableGatewayAuth?: boolean;
  image?: string;
  token?: string;
  configDir?: string;
  workspaceDir?: string;
  projectName?: string;
  sharedSkillsDir?: string;
  sharedSkillsMount?: string;
  authChoice?: string;
  force?: boolean;
  inheritAuth?: boolean;
  inheritAuthFrom?: string;
  inheritModels?: boolean;
  inheritWebSearch?: boolean;
  inheritManagedSkills?: boolean;
  openaiApiKey?: string;
  anthropicApiKey?: string;
  setupToken?: string;
};

type InstanceConfig = Record<string, unknown>;

function mergeConfig(params: {
  existingConfig: InstanceConfig | null;
  sourceConfig: InstanceConfig | null;
  gatewayPort: number;
  bind: BindMode;
  allowLanAccess: boolean;
  approveDevice: boolean;
  disableGatewayAuth: boolean;
  token: string;
  sharedSkillsMount: string;
  hasSharedSkills: boolean;
  inheritAuth: boolean;
  inheritModels: boolean;
  inheritWebSearch: boolean;
}) {
  const baseConfig =
    params.inheritAuth && params.sourceConfig ? mergeRecords({}, params.sourceConfig) : {};
  const next = mergeRecords(baseConfig, params.existingConfig ?? {});
  const currentSession = getObject(next.session);
  next.session = {
    ...currentSession,
    dmScope: currentSession.dmScope ?? "per-channel-peer",
  };

  const currentGateway = getObject(next.gateway);
  next.gateway = {
    ...currentGateway,
    mode: currentGateway.mode ?? "local",
    port: params.gatewayPort,
    bind: params.bind,
  };
  delete (next.gateway as Record<string, unknown>).remote;
  const currentControlUi = getObject(currentGateway.controlUi);
  (next.gateway as Record<string, unknown>).controlUi = {
    ...currentControlUi,
    allowedOrigins: params.allowLanAccess
      ? ["*"]
      : [`http://localhost:${params.gatewayPort}`, `http://127.0.0.1:${params.gatewayPort}`],
    dangerouslyDisableDeviceAuth: !params.approveDevice,
  };
  const currentAuth = getObject(currentGateway.auth);
  (next.gateway as Record<string, unknown>).auth = {
    ...currentAuth,
    mode: params.disableGatewayAuth ? "none" : (currentAuth.mode ?? "token"),
    token: params.disableGatewayAuth ? undefined : params.token,
    password: params.disableGatewayAuth ? undefined : currentAuth.password,
  };

  const nextAgents = getObject(next.agents);
  const nextAgentDefaults = getObject(nextAgents.defaults);
  delete nextAgentDefaults.workspace;
  next.agents = {
    ...nextAgents,
    defaults: nextAgentDefaults,
  };
  delete (next.agents as Record<string, unknown>).list;

  const nextPlugins = getObject(next.plugins);
  const nextPluginLoad = getObject(nextPlugins.load);
  delete nextPluginLoad.paths;
  next.plugins = {
    ...nextPlugins,
    load: nextPluginLoad,
  };

  if (params.hasSharedSkills) {
    const currentSkills = getObject(next.skills);
    const currentLoad = getObject(currentSkills.load);
    const extraDirs = new Set(Array.isArray(currentLoad.extraDirs) ? currentLoad.extraDirs : []);
    extraDirs.add(params.sharedSkillsMount);
    next.skills = {
      ...currentSkills,
      load: {
        ...currentLoad,
        extraDirs: [...extraDirs],
      },
    };
  }

  if (params.inheritModels) {
    const sourceAgents = getObject(params.sourceConfig?.agents);
    const sourceDefaults = getObject(sourceAgents.defaults);
    const targetAgents = getObject(next.agents);
    const targetDefaults = getObject(targetAgents.defaults);
    if (Object.keys(getObject(sourceDefaults.model)).length > 0) {
      targetDefaults.model = sourceDefaults.model;
    }
    if (Object.keys(getObject(sourceDefaults.models)).length > 0) {
      targetDefaults.models = sourceDefaults.models;
    }
    next.agents = {
      ...targetAgents,
      defaults: targetDefaults,
    };
  } else {
    const targetAgents = getObject(next.agents);
    const targetDefaults = getObject(targetAgents.defaults);
    delete targetDefaults.model;
    delete targetDefaults.models;
    next.agents = {
      ...targetAgents,
      defaults: targetDefaults,
    };
  }

  if (
    params.inheritWebSearch &&
    params.sourceConfig?.tools &&
    typeof params.sourceConfig.tools === "object"
  ) {
    const tools = params.sourceConfig.tools as Record<string, unknown>;
    if (tools.web && typeof tools.web === "object") {
      const currentTools =
        typeof next.tools === "object" && next.tools ? (next.tools as Record<string, unknown>) : {};
      next.tools = {
        ...currentTools,
        web: tools.web,
      };
    }
  } else {
    const currentTools = getObject(next.tools);
    delete currentTools.web;
    next.tools = currentTools;
  }

  return next;
}

async function promptInitOptions(input: InitOptions) {
  intro("OPENCLAW MULTI USER");
  note("Docker 多用户实例初始化", "初始化");
  const baseDir = path.resolve(
    String(
      await text({
        message: "根目录",
        initialValue: input.baseDir || DEFAULT_BASE_DIR,
      }),
    ),
  );
  const instance = sanitizeName(
    String(
      await text({
        message: "实例名称",
        initialValue: input.instance || "",
      }),
    ),
  );
  const gatewayPort = parsePort(
    String(
      await text({
        message: "Gateway 端口",
        initialValue: input.gatewayPort || "18789",
      }),
    ),
    18789,
    "Gateway port",
  );
  const bridgePort = parsePort(
    String(
      await text({
        message: "Bridge 端口",
        initialValue: input.bridgePort || String(gatewayPort + 1),
      }),
    ),
    gatewayPort + 1,
    "Bridge port",
  );
  const bind = (await select({
    message: "绑定模式",
    options: [
      { value: "lan", label: "lan", hint: "Docker 场景下宿主机浏览器可访问" },
      { value: "loopback", label: "loopback", hint: "仅容器内可访问" },
    ],
    initialValue: (input.bind as BindMode | undefined) || DEFAULT_BIND,
  })) as BindMode;
  const allowLanAccess = Boolean(
    await confirm({
      message: "是否开放局域网访问？",
      initialValue: input.allowLanAccess ?? false,
    }),
  );
  const approveDevice = Boolean(
    await confirm({
      message: "是否启用设备验证？",
      initialValue: input.approveDevice ?? true,
    }),
  );
  const disableGatewayAuth = Boolean(
    await confirm({
      message: "是否关闭 Gateway 鉴权？",
      initialValue: input.disableGatewayAuth ?? false,
    }),
  );
  const instanceDir = instanceDirFor(baseDir, instance);
  const configDir = path.resolve(
    String(
      await text({
        message: "配置目录",
        initialValue: input.configDir || path.join(instanceDir, ".openclaw"),
      }),
    ),
  );
  const workspaceDir = path.resolve(
    String(
      await text({
        message: "工作区目录",
        initialValue: input.workspaceDir || path.join(instanceDir, "workspace"),
      }),
    ),
  );
  const projectName = String(
    await text({
      message: "Compose 项目名",
      initialValue: input.projectName || `openclaw-${instance}`,
    }),
  );
  const image = String(
    await text({
      message: "Docker 镜像",
      initialValue: input.image || DEFAULT_IMAGE,
    }),
  );
  const sharedSkillsInput = String(
    await text({
      message: "共享 skills 宿主机目录",
      initialValue: input.sharedSkillsDir || "",
      placeholder: "可选",
    }),
  ).trim();
  const sharedSkillsDir = sharedSkillsInput ? path.resolve(sharedSkillsInput) : "";
  const sharedSkillsMount = sharedSkillsDir
    ? String(
        await text({
          message: "共享 skills 挂载路径",
          initialValue: input.sharedSkillsMount || DEFAULT_SHARED_SKILLS_MOUNT,
        }),
      )
    : input.sharedSkillsMount || DEFAULT_SHARED_SKILLS_MOUNT;
  const authChoice = resolveAuthChoice(
    String(
      await select({
        message: "认证方式",
        options: [
          { value: "skip", label: "skip", hint: "稍后再配置" },
          { value: "openai-api-key", label: "openai-api-key" },
          { value: "apiKey", label: "apiKey" },
          { value: "openai-codex", label: "openai-codex" },
          { value: "token", label: "token" },
        ],
        initialValue: resolveAuthChoice(input.authChoice),
      }),
    ),
  );
  const token = String(
    await text({
      message: "Gateway token",
      initialValue: input.token || randomToken(),
    }),
  );
  const inheritAuth = Boolean(
    await confirm({
      message: "是否继承 ~/.openclaw 中的本地认证信息？",
      initialValue: Boolean(input.inheritAuth),
    }),
  );
  const inheritAuthFrom = path.resolve(
    String(
      await text({
        message: "认证来源目录",
        initialValue: input.inheritAuthFrom || path.join(process.env.HOME || "", ".openclaw"),
      }),
    ),
  );
  const inheritModels = Boolean(
    await confirm({
      message: "是否继承来源 openclaw.json 中的模型配置？",
      initialValue: Boolean(input.inheritModels),
    }),
  );
  const inheritWebSearch = Boolean(
    await confirm({
      message: "是否继承来源 openclaw.json 中的 Web 搜索配置？",
      initialValue: Boolean(input.inheritWebSearch),
    }),
  );
  const inheritManagedSkills = Boolean(
    await confirm({
      message: "是否复用来源 skills 作为共享 managed skills？",
      initialValue: Boolean(input.inheritManagedSkills),
    }),
  );
  return {
    ...input,
    baseDir,
    instance,
    gatewayPort: String(gatewayPort),
    bridgePort: String(bridgePort),
    bind,
    allowLanAccess,
    approveDevice,
    disableGatewayAuth,
    configDir,
    workspaceDir,
    projectName,
    image,
    sharedSkillsDir,
    sharedSkillsMount,
    authChoice,
    token,
    inheritAuth,
    inheritAuthFrom,
    inheritModels,
    inheritWebSearch,
    inheritManagedSkills,
  };
}

export async function runInit(input: InitOptions) {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const options = interactive ? await promptInitOptions(input) : input;

  const instance = sanitizeName(options.instance || "");
  const baseDir = path.resolve(options.baseDir || DEFAULT_BASE_DIR);
  const gatewayPort = parsePort(options.gatewayPort, 18789, "Gateway port");
  const bridgePort = parsePort(options.bridgePort, gatewayPort + 1, "Bridge port");
  const bind = (options.bind as BindMode | undefined) || DEFAULT_BIND;
  const allowLanAccess = options.allowLanAccess ?? false;
  const approveDevice = options.approveDevice ?? true;
  const disableGatewayAuth = options.disableGatewayAuth ?? false;
  if (bind !== "lan" && bind !== "loopback") {
    fail("Bind mode must be lan or loopback.");
  }
  const instanceDir = instanceDirFor(baseDir, instance);
  const configDir = path.resolve(options.configDir || path.join(instanceDir, ".openclaw"));
  const workspaceDir = path.resolve(options.workspaceDir || path.join(instanceDir, "workspace"));
  const projectName = options.projectName || `openclaw-${instance}`;
  const image = options.image || DEFAULT_IMAGE;
  const authChoice = resolveAuthChoice(options.authChoice);
  const inheritAuth = Boolean(options.inheritAuth);
  const inheritAuthFrom = path.resolve(
    options.inheritAuthFrom || path.join(process.env.HOME || "", ".openclaw"),
  );
  const inheritModels = Boolean(options.inheritModels);
  const inheritWebSearch = Boolean(options.inheritWebSearch);
  const inheritManagedSkills = Boolean(options.inheritManagedSkills);
  const sharedSkillsDir = options.sharedSkillsDir
    ? path.resolve(options.sharedSkillsDir)
    : inheritManagedSkills
      ? path.resolve(path.join(inheritAuthFrom, "skills"))
      : "";
  const sharedSkillsMount = options.sharedSkillsMount || DEFAULT_SHARED_SKILLS_MOUNT;
  const token = options.token || randomToken();

  const envFile = envFileFor(baseDir, instance);
  const extraComposeFile = extraComposeFileFor(baseDir, instance);
  const metadataFile = metadataFileFor(baseDir, instance);
  if ((await pathExists(envFile)) && !options.force) {
    if (interactive) {
      const overwrite = Boolean(
        await confirm({
          message: `${envFile} 已存在，是否覆盖？`,
          initialValue: false,
        }),
      );
      if (!overwrite) {
        fail(`${envFile} already exists. Re-run with --force to overwrite it.`);
      }
      options.force = true;
    } else {
      fail(`${envFile} already exists. Re-run with --force to overwrite it.`);
    }
  }

  await ensureDir(configDir);
  await ensureDir(workspaceDir);
  await ensureDir(path.join(configDir, "extensions"));
  await ensureDir(path.join(configDir, "identity"));
  await ensureDir(path.join(configDir, "agents/main/agent"));
  await ensureDir(path.join(configDir, "agents/main/sessions"));

  if (options.force) {
    await clearInstanceSessions(configDir);
    await ensureDir(path.join(configDir, "agents/main/sessions"));
  }

  if (sharedSkillsDir) {
    await ensureDir(sharedSkillsDir);
    await writeTextFile(
      extraComposeFile,
      buildExtraComposeContents(sharedSkillsDir, sharedSkillsMount),
    );
  } else {
    await fs.rm(extraComposeFile, { force: true });
  }

  const sourceConfigPath = path.join(inheritAuthFrom, "openclaw.json");
  const mergedConfig = mergeConfig({
    existingConfig: await readJson5File<InstanceConfig>(path.join(configDir, "openclaw.json")),
    sourceConfig: await readJson5File<InstanceConfig>(sourceConfigPath),
    gatewayPort,
    bind,
    allowLanAccess,
    approveDevice,
    disableGatewayAuth,
    token,
    sharedSkillsMount,
    hasSharedSkills: Boolean(sharedSkillsDir),
    inheritAuth,
    inheritModels,
    inheritWebSearch,
  });
  await writeJsonFile(path.join(configDir, "openclaw.json"), mergedConfig);

  if (inheritAuth) {
    await inheritAuthProfiles(inheritAuthFrom, configDir);
  }

  const env = {
    OPENCLAW_CONFIG_DIR: configDir,
    OPENCLAW_WORKSPACE_DIR: workspaceDir,
    OPENCLAW_GATEWAY_PORT: String(gatewayPort),
    OPENCLAW_BRIDGE_PORT: String(bridgePort),
    OPENCLAW_GATEWAY_BIND: bind,
    OPENCLAW_GATEWAY_TOKEN: disableGatewayAuth ? "" : token,
    OPENCLAW_IMAGE: image,
    OPENCLAW_INSTANCE_NAME: instance,
    OPENCLAW_PROJECT_NAME: projectName,
    OPENCLAW_SHARED_SKILLS_DIR: sharedSkillsDir,
    OPENCLAW_SHARED_SKILLS_MOUNT: sharedSkillsMount,
    OPENCLAW_INIT_AUTH_CHOICE: authChoice,
    OPENCLAW_INHERIT_AUTH: inheritAuth ? "1" : "0",
    OPENCLAW_INHERIT_AUTH_FROM: inheritAuth ? inheritAuthFrom : "",
    OPENAI_API_KEY: authChoice === "openai-api-key" ? options.openaiApiKey || "" : "",
    ANTHROPIC_API_KEY: authChoice === "apiKey" ? options.anthropicApiKey || "" : "",
    OPENCLAW_SETUP_TOKEN: authChoice === "token" ? options.setupToken || "" : "",
    OPENCLAW_DISABLE_GATEWAY_AUTH: disableGatewayAuth ? "1" : "0",
  } satisfies InstanceEnv;

  await writeTextFile(envFile, buildEnvFileContents(env));
  await writeTextFile(
    metadataFile,
    buildMetadataYaml({
      instance,
      projectName,
      gatewayPort,
      bridgePort,
      bind,
      allowLanAccess,
      approveDevice,
      disableGatewayAuth,
      image,
      configDir,
      workspaceDir,
      authChoice,
      inheritAuth,
      inheritAuthFrom,
      inheritModels,
      inheritWebSearch,
      inheritManagedSkills,
      sharedSkillsDir,
      sharedSkillsMount,
    }),
  );

  console.log(`Initialized instance: ${instance}`);
  console.log(`  project: ${projectName}`);
  console.log(`  env: ${envFile}`);
  console.log(`  config: ${configDir}`);
  console.log(`  workspace: ${workspaceDir}`);
  console.log(`  plugins: ${path.join(configDir, "extensions")}`);
  console.log(`  gateway: http://127.0.0.1:${gatewayPort}/`);
  console.log(`  metadata: ${metadataFile}`);
  console.log("");
  console.log("下一步：");
  console.log(`  1. pnpm docker:mu -- start ${instance}`);
  console.log(`  2. pnpm docker:mu -- auth ${instance}`);
  if (disableGatewayAuth) {
    console.log("  3. 已关闭 Gateway 鉴权，可直接打开 Dashboard");
  } else if (approveDevice) {
    console.log(`  3. pnpm docker:mu -- approve-device ${instance}`);
  } else {
    console.log("  3. 已关闭设备验证，可直接使用带 token 的 Dashboard URL");
  }
}
