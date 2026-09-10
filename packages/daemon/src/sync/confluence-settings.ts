/**
 * Daemon-side Confluence credentials, following the same persistence pattern
 * as the repo settings: a JSON file under CONFIG_DIR written atomically at mode
 * 0600 (the API token lands in it), read tolerantly, and overridable for
 * tests via CDS_DESIGN_CONFLUENCE_SETTINGS. The token crosses the wire only as
 * presence.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR } from "../environment.js";

/** On-disk Confluence settings: the API token lives in the OS store. */
export interface StoredConfluenceSettings {
  siteUrl: string | null;
  email: string | null;
  apiToken: string | null;
}

function settingsFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.CDS_DESIGN_CONFLUENCE_SETTINGS ?? join(CONFIG_DIR, "confluence.json");
}

/** A setting that is missing or whitespace-only reads as unset. */
function cleanSetting(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export function loadConfluenceSettings(env: NodeJS.ProcessEnv = process.env): StoredConfluenceSettings {
  try {
    const parsed = JSON.parse(readFileSync(settingsFile(env), "utf8")) as Partial<StoredConfluenceSettings>;
    return {
      siteUrl: cleanSetting(parsed.siteUrl),
      email: cleanSetting(parsed.email),
      apiToken: typeof parsed.apiToken === "string" ? parsed.apiToken : null,
    };
  } catch {
    return { siteUrl: null, email: null, apiToken: null };
  }
}

/**
 * Full credentials with env overrides and the stored token: the settings
 * file supplies site/email, CDS_DESIGN_CONFLUENCE_{SITE,EMAIL,TOKEN} win
 * (tests, headless), and the token itself comes from the caller's store.
 */
export function confluenceCredentials(
  settings: StoredConfluenceSettings,
  env: NodeJS.ProcessEnv,
  token: string | null,
): StoredConfluenceSettings {
  return {
    // An empty string is unset, not a value: it would otherwise reach the
    // transport and turn every request into a relative-URL fetch failure
    // (boundary-cohort dogfood finding).
    siteUrl: cleanSetting(env.CDS_DESIGN_CONFLUENCE_SITE) ?? cleanSetting(settings.siteUrl),
    email: cleanSetting(env.CDS_DESIGN_CONFLUENCE_EMAIL) ?? cleanSetting(settings.email),
    apiToken: cleanSetting(env.CDS_DESIGN_CONFLUENCE_TOKEN) ?? token,
  };
}

export function saveConfluenceSettings(
  settings: StoredConfluenceSettings,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const file = settingsFile(env);
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.cds-design-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

/** Whether every credential the client needs is present. */
export function confluenceConfigured(settings: StoredConfluenceSettings): boolean {
  return Boolean(settings.siteUrl && settings.email && settings.apiToken);
}

export function settingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return settingsFile(env);
}
