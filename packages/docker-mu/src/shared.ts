import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSON5 from "json5";
import YAML from "yaml";

export type AuthChoice = "skip" | "openai-api-key" | "apiKey" | "openai-codex" | "token";
export type BindMode = "lan" | "loopback";

export type InstanceEnv = {
  OPENCLAW_CONFIG_DIR: string;
  OPENCLAW_WORKSPACE_DIR: string;
  OPENCLAW_GATEWAY_PORT: string;
  OPENCLAW_BRIDGE_PORT: string;
  OPENCLAW_GATEWAY_BIND: BindMode;
  OPENCLAW_GATEWAY_TOKEN: string;
  OPENCLAW_IMAGE: string;
  OPENCLAW_INSTANCE_NAME: string;
  OPENCLAW_PROJECT_NAME: string;
  OPENCLAW_SHARED_SKILLS_DIR: string;
  OPENCLAW_SHARED_SKILLS_MOUNT: string;
  OPENCLAW_INIT_AUTH_CHOICE: AuthChoice;
  OPENCLAW_INHERIT_AUTH: "0" | "1";
  OPENCLAW_INHERIT_AUTH_FROM: string;
  OPENAI_API_KEY: string;
  ANTHROPIC_API_KEY: string;
  OPENCLAW_SETUP_TOKEN: string;
  OPENCLAW_DISABLE_GATEWAY_AUTH: "0" | "1";
};

export const ROOT_DIR = path.resolve(path.join(import.meta.dirname, "../../.."));
export const COMPOSE_FILE = path.join(ROOT_DIR, "docker-compose.yml");
export const DEFAULT_BASE_DIR = path.resolve(
  process.env.OPENCLAW_MULTI_USER_ROOT?.trim() || path.join(os.homedir(), ".openclaw-multi-user"),
);
export const DEFAULT_IMAGE = process.env.OPENCLAW_IMAGE?.trim() || "openclaw:local";
export const DEFAULT_BIND: BindMode = "lan";
export const DEFAULT_SHARED_SKILLS_MOUNT = "/shared-skills";

export function fail(message: string): never {
  throw new Error(message);
}

export function sanitizeName(raw: string): string {
  const trimmed = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!trimmed) {
    fail("Instance name must contain at least one letter or number.");
  }
  return trimmed;
}

export function parsePort(
  raw: string | number | undefined,
  fallback: number,
  label: string,
): number {
  const value = raw === undefined ? String(fallback) : String(raw).trim();
  if (!/^\d+$/.test(value)) {
    fail(`${label} must be numeric.`);
  }
  return Number.parseInt(value, 10);
}

export function resolveAuthChoice(value: string | undefined): AuthChoice {
  const choice = (value?.trim() || "skip") as AuthChoice;
  if (!["skip", "openai-api-key", "apiKey", "openai-codex", "token"].includes(choice)) {
    fail(`Unsupported auth choice: ${choice}`);
  }
  return choice;
}

export function instancesDirFor(baseDir: string) {
  return path.join(baseDir, "instances");
}

export function instanceDirFor(baseDir: string, instance: string) {
  return path.join(instancesDirFor(baseDir), instance);
}

export function legacyInstanceDirFor(baseDir: string, instance: string) {
  return path.join(baseDir, instance);
}

export function envFileFromInstanceDir(instanceDir: string) {
  return path.join(instanceDir, ".env");
}

export function extraComposeFileFromInstanceDir(instanceDir: string) {
  return path.join(instanceDir, "docker-compose.extra.yml");
}

export function envFileFor(baseDir: string, instance: string) {
  return envFileFromInstanceDir(instanceDirFor(baseDir, instance));
}

export function extraComposeFileFor(baseDir: string, instance: string) {
  return extraComposeFileFromInstanceDir(instanceDirFor(baseDir, instance));
}

export function metadataFileFor(baseDir: string, instance: string) {
  return path.join(instanceDirFor(baseDir, instance), "instance.yaml");
}

export async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function readJson5File<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON5.parse(raw);
  } catch {
    return null;
  }
}

export async function writeJsonFile(filePath: string, value: unknown) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

export async function writeTextFile(filePath: string, value: string) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, value, "utf-8");
}

export async function copyFileIfExists(source: string, destination: string) {
  if (!(await pathExists(source))) {
    return;
  }
  await ensureDir(path.dirname(destination));
  await fs.copyFile(source, destination);
}

export async function copyDirIfExists(source: string, destination: string) {
  if (!(await pathExists(source))) {
    return;
  }
  await ensureDir(path.dirname(destination));
  await fs.cp(source, destination, { recursive: true, force: true });
}

export async function clearInstanceSessions(configDir: string) {
  const agentsRoot = path.join(configDir, "agents");
  if (!(await pathExists(agentsRoot))) {
    return;
  }
  const entries = await fs.readdir(agentsRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const agentDir = path.join(agentsRoot, entry.name);
    await fs.rm(path.join(agentDir, "sessions"), { recursive: true, force: true });
    await fs.rm(path.join(agentDir, "sessions.json"), { force: true });
  }
}

export async function inheritAuthProfiles(sourceStateDir: string, targetConfigDir: string) {
  await copyFileIfExists(
    path.join(sourceStateDir, "agents/main/agent/auth-profiles.json"),
    path.join(targetConfigDir, "agents/main/agent/auth-profiles.json"),
  );
  await copyFileIfExists(
    path.join(sourceStateDir, "agents/main/agent/auth.json"),
    path.join(targetConfigDir, "agents/main/agent/auth.json"),
  );
  await copyFileIfExists(
    path.join(sourceStateDir, "credentials/oauth.json"),
    path.join(targetConfigDir, "credentials/oauth.json"),
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function mergeRecords(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(next[key])) {
      next[key] = mergeRecords(next[key], value);
      continue;
    }
    next[key] = value;
  }
  return next;
}

export function getObject(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {};
}

export function randomToken() {
  return randomBytes(32).toString("hex");
}

export function parseEnvFile(raw: string): InstanceEnv {
  const lines = raw.split(/\r?\n/);
  const env = {} as Record<string, string>;
  for (const line of lines) {
    if (!line || line.startsWith("#")) {
      continue;
    }
    const index = line.indexOf("=");
    if (index <= 0) {
      continue;
    }
    env[line.slice(0, index)] = line.slice(index + 1);
  }
  return env as InstanceEnv;
}

export async function resolveInstanceDirForRead(
  baseDir: string,
  instance: string,
): Promise<string> {
  const candidates = [instanceDirFor(baseDir, instance), legacyInstanceDirFor(baseDir, instance)];
  for (const candidate of candidates) {
    if (await pathExists(envFileFromInstanceDir(candidate))) {
      return candidate;
    }
  }
  fail(`Missing env file: ${envFileFor(baseDir, instance)}. Run init first.`);
}

export async function loadInstanceEnv(baseDir: string, instance: string): Promise<InstanceEnv> {
  const instanceDir = await resolveInstanceDirForRead(baseDir, instance);
  return parseEnvFile(await fs.readFile(envFileFromInstanceDir(instanceDir), "utf-8"));
}

export function buildEnvFileContents(env: InstanceEnv) {
  return `${Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")}\n`;
}

export function buildExtraComposeContents(sharedSkillsDir: string, sharedSkillsMount: string) {
  return YAML.stringify({
    services: {
      "openclaw-gateway": {
        volumes: [`${sharedSkillsDir}:${sharedSkillsMount}:ro`],
      },
      "openclaw-cli": {
        volumes: [`${sharedSkillsDir}:${sharedSkillsMount}:ro`],
      },
    },
  });
}

export function buildMetadataYaml(params: {
  instance: string;
  projectName: string;
  gatewayPort: number;
  bridgePort: number;
  bind: BindMode;
  allowLanAccess: boolean;
  image: string;
  configDir: string;
  workspaceDir: string;
  approveDevice: boolean;
  disableGatewayAuth: boolean;
  authChoice: AuthChoice;
  inheritAuth: boolean;
  inheritAuthFrom: string;
  inheritModels: boolean;
  inheritWebSearch: boolean;
  inheritManagedSkills: boolean;
  sharedSkillsDir: string;
  sharedSkillsMount: string;
}) {
  return YAML.stringify({
    instance: params.instance,
    project_name: params.projectName,
    gateway: {
      port: params.gatewayPort,
      bridge_port: params.bridgePort,
      bind: params.bind,
      allow_lan_access: params.allowLanAccess,
    },
    control_ui: {
      approve_device: params.approveDevice,
    },
    gateway_auth: {
      disabled: params.disableGatewayAuth,
    },
    image: params.image,
    paths: {
      config_dir: params.configDir,
      workspace_dir: params.workspaceDir,
    },
    auth: {
      choice: params.authChoice,
      inherit_auth: params.inheritAuth,
      inherit_auth_from: params.inheritAuthFrom,
    },
    inherit: {
      models: params.inheritModels,
      web_search: params.inheritWebSearch,
      managed_skills: params.inheritManagedSkills,
    },
    shared_skills: {
      dir: params.sharedSkillsDir,
      mount: params.sharedSkillsMount,
    },
  });
}

export function composeArgs(envFile: string, projectName: string, extraComposeFile?: string) {
  const args = [
    "compose",
    "--project-name",
    projectName,
    "--env-file",
    envFile,
    "-f",
    COMPOSE_FILE,
  ];
  if (extraComposeFile) {
    args.push("-f", extraComposeFile);
  }
  return args;
}

export function ensureDockerAvailable() {
  const result = spawnSync("docker", ["compose", "version"], { stdio: "ignore" });
  if (result.status !== 0) {
    fail("Docker Compose is not available.");
  }
}

export async function runDockerCompose(
  envFile: string,
  projectName: string,
  extraComposeFile: string | undefined,
  args: string[],
  options: { stdio?: "inherit" | "pipe"; extraEnv?: NodeJS.ProcessEnv } = {},
) {
  const fullArgs = [...composeArgs(envFile, projectName, extraComposeFile), ...args];
  return await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn("docker", fullArgs, {
      stdio: options.stdio ?? "inherit",
      env: { ...process.env, ...options.extraEnv },
    });
    let stdout = "";
    let stderr = "";
    if (options.stdio === "pipe") {
      child.stdout?.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });
    }
    child.on("error", reject);
    child.on("close", (code) => {
      if (code && code !== 0) {
        reject(new Error(stderr || `docker compose exited with code ${code}`));
        return;
      }
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });
}
