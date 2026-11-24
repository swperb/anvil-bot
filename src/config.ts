import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface Config {
  token: string;
  guildId: string | null;
  dataDir: string;
  adminRoleId: string | null;
  logChannelId: string | null;
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
  return {
    token,
    guildId: snowflake(env, "GUILD_ID"),
    dataDir: resolve(env.DATA_DIR?.trim() || "./data"),
    adminRoleId: snowflake(env, "ADMIN_ROLE_ID"),
    logChannelId: snowflake(env, "LOG_CHANNEL_ID"),
  };
}
