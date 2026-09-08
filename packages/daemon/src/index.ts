import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DaemonServer } from "./server.js";
import { HUB_DIR, buildStatus, childPath, resolveClaudeExecutable } from "./environment.js";

const CONFIG_FILE = join(HUB_DIR, "daemon.json");

interface StoredConfig {
  host: string;
  port: number;
  token: string;
}

function loadConfig(): StoredConfig {
  mkdirSync(HUB_DIR, { recursive: true });
  // A second daemon on the same machine — an end-to-end suite while the user's
  // own daemon is running — needs a port of its own or it dies on bind.
  const override = Number(process.env.AGENT_HUB_PORT);
  if (existsSync(CONFIG_FILE)) {
    try {
      const stored = JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as StoredConfig;
      return override > 0 ? { ...stored, port: override } : stored;
    } catch {
      // Fall through and rewrite a fresh config.
    }
  }
  const config: StoredConfig = {
    host: "127.0.0.1",
    port: override > 0 ? override : 7823,
    token: randomBytes(24).toString("hex"),
  };
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
  return config;
}

async function doctor(): Promise<number> {
  const executable = await resolveClaudeExecutable();
  const status = await buildStatus({
    executable,
    liveSessions: 0,
    pendingPermissions: 0,
    registryProbeDir: null,
  });
  console.log(JSON.stringify(status, null, 2));
  if (status.warnings.length > 0) {
    console.error("\nProblems found:");
    for (const warning of status.warnings) console.error(`  - ${warning}`);
    return 1;
  }
  console.error("\nAll checks passed.");
  return 0;
}

async function main(): Promise<void> {
  // Started from a desktop app rather than a shell, this process inherits a
  // PATH with no node on it, and every tool we drive — the Claude CLI, pnpm,
  // vite — is a script whose shebang resolves node through PATH. Widen it once
  // here so children inherit it instead of each spawn site remembering.
  process.env.PATH = childPath();

  const command = process.argv[2];

  if (command === "doctor") {
    process.exit(await doctor());
  }

  const config = loadConfig();
  const server = new DaemonServer(config);
  await server.start();

  const url = `ws://${config.host}:${config.port}?token=${config.token}`;
  console.log(`agent-hub daemon listening on http://${config.host}:${config.port}`);
  console.log(`client url: ${url}`);
  console.log(`config: ${CONFIG_FILE}`);

  if (process.env.ANTHROPIC_API_KEY) {
    console.warn(
      "\nWARNING: ANTHROPIC_API_KEY is set. Sessions will bill that key instead of your subscription.",
    );
  }

  const shutdown = async () => {
    console.log("\nshutting down...");
    await server.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
