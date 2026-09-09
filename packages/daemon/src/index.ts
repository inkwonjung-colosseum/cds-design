import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DaemonServer } from "./server.js";
import { CONFIG_DIR, buildStatus, childPath, resolveClaudeExecutable } from "./environment.js";
import { createCredentialStore, loadConfluenceToken, loadRepoPat, migratePlaintextSecrets } from "./credentials.js";
import { runOnboardingChecks } from "./onboarding.js";
import { RepoWorkspace } from "./repo.js";
import { ProjectRegistry } from "./projects.js";
import { SyncEngine } from "./sync/sync-engine.js";
import { ConfluenceClient } from "./sync/confluence-client.js";
import { createConfluenceTransport, FetchTransport } from "./sync/fixture-transport.js";
import {
  confluenceCredentials,
  loadConfluenceSettings,
  confluenceConfigured,
} from "./sync/confluence-settings.js";

const CONFIG_FILE = join(CONFIG_DIR, "daemon.json");

interface StoredConfig {
  host: string;
  port: number;
  token: string;
}

function loadConfig(): StoredConfig {
  mkdirSync(CONFIG_DIR, { recursive: true });
  // A second daemon on the same machine — an end-to-end suite while the user's
  // own daemon is running — needs a port of its own or it dies on bind.
  const override = Number(process.env.DRAFTHOUSE_PORT);
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

  // The onboarding checks are doctor's product surface (DESIGN §8, PLAN M1).
  const credentials = createCredentialStore();
  await migratePlaintextSecrets(credentials);
  const transport = createConfluenceTransport();
  const token = await loadConfluenceToken(credentials);
  const clientFactory = () => {
    const stored = confluenceCredentials(loadConfluenceSettings(), process.env, token);
    if (!confluenceConfigured(stored)) return null;
    return new ConfluenceClient(
      { siteUrl: stored.siteUrl!, email: stored.email!, apiToken: stored.apiToken! },
      transport.transport ?? new FetchTransport(stored.siteUrl!),
    );
  };

  // Read-only: doctor reports, it never migrates a layout or clones anything.
  // A machine with no project yet reports exactly that, which is the point.
  const registry = ProjectRegistry.load();
  const active = registry.active();
  const paths = active ? registry.paths(active.slug) : null;
  const onboarding = await runOnboardingChecks({
    repo:
      active && paths
        ? new RepoWorkspace({
            root: paths.repoRoot,
            url: active.repo.url,
            pat: await loadRepoPat(credentials, active.slug),
            onStatus: () => undefined,
          })
        : null,
    confluence: paths
      ? new SyncEngine({ root: paths.mirrorRoot, clientFactory, onStatus: () => undefined })
      : null,
    projectName: active?.name ?? null,
    confluenceClient: clientFactory,
  });
  console.log(JSON.stringify({ ...status, onboarding }, null, 2));
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
  console.log(`drafthouse daemon listening on http://${config.host}:${config.port}`);
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
