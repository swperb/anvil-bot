import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface Config {
  token: string;
  guildId: string | null;
  dataDir: string;
  adminRoleId: string | null;
  logChannelId: string | null;
  /** GitHub token for filing confirmed bug reports, or null when not set up. */
  githubToken: string | null;
  /** owner/name of the repository bug reports are filed in and the feed watches. */
  githubRepo: string;
  /** Post the repository's activity to #releases and #github (FEED=off turns it off). */
  feed: boolean;
}

const SNOWFLAKE = /^\d{17,20}$/;

export class ConfigError extends Error {
  override name = "ConfigError";
}

function snowflake(env: NodeJS.ProcessEnv, key: string): string | null {
  const value = env[key]?.trim();
  if (!value) return null;
  if (!SNOWFLAKE.test(value)) {
    throw new ConfigError(`${key} must be a Discord ID (17 to 20 digits), not "${value}".`);
  }
  return value;
}

/** An optional token file: missing means "not set up", anything else wrong is an error. */
function readOptionalToken(file: string | undefined): string | null {
  if (!file) return null;
  let value: string;
  try {
    value = readFileSync(file, "utf8").trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ConfigError(`Cannot read ${file} (${(err as NodeJS.ErrnoException).code ?? "unknown error"}).`);
  }
  if (!value) return null;
  if (/\s/.test(value)) throw new ConfigError(`${file} contains spaces or line breaks. Write only the token to the file.`);
  return value;
}

/**
 * Read the configuration from the environment. The token comes from
 * DISCORD_TOKEN_FILE (preferred) or DISCORD_TOKEN, and is never logged.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  let token = env.DISCORD_TOKEN?.trim() ?? "";
  const tokenFile = env.DISCORD_TOKEN_FILE?.trim();
  if (!token && tokenFile) {
    try {
      token = readFileSync(tokenFile, "utf8").trim();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "unknown error";
      throw new ConfigError(`Cannot read the token file ${tokenFile} (${code}). See README, "The token".`);
    }
  }
  if (!token) {
    throw new ConfigError(
      'No bot token. Set DISCORD_TOKEN_FILE to a file that holds the token. See README, "The token".',
    );
  }
  if (/\s/.test(token)) {
    throw new ConfigError("The bot token contains spaces or line breaks. Write only the token to the file.");
  }
  const githubRepo = env.GITHUB_REPO?.trim() || "swperb/anvilcad";
  if (!/^[\w.-]+\/[\w.-]+$/.test(githubRepo)) throw new ConfigError(`GITHUB_REPO must look like owner/name, not "${githubRepo}".`);
  return {
    token,
    githubToken: readOptionalToken(env.GITHUB_TOKEN_FILE?.trim()),
    githubRepo,
    feed: !/^(off|false|0|no)$/i.test(env.FEED?.trim() ?? ""),
    guildId: snowflake(env, "GUILD_ID"),
    dataDir: resolve(env.DATA_DIR?.trim() || "./data"),
    adminRoleId: snowflake(env, "ADMIN_ROLE_ID"),
    logChannelId: snowflake(env, "LOG_CHANNEL_ID"),
  };
}
