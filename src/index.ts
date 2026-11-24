// Anvil: the admin bot for the AnvilCAD Discord server.

import { join } from "node:path";
import { ActivityType, Client, EmbedBuilder, Events, GatewayIntentBits, MessageFlags, type Guild } from "discord.js";
import { checkAuthorised, type Rules } from "./auth.ts";
import { Audit } from "./audit.ts";
import { GitHub } from "./bounty/github.ts";
import { BountyStore, type Report } from "./bounty/store.ts";
import { handleBountyComponent, type BountyDeps } from "./bounty/triage.ts";
import { actorOf } from "./command.ts";
import { COMMANDS } from "./commands/index.ts";
import { ConfigError, loadConfig, type Config } from "./config.ts";
import { describeError, UserError } from "./errors.ts";
import { GitHubFeed, type FeedPost } from "./feed.ts";
import { Journal } from "./journal.ts";
import { log, logToDir } from "./log.ts";
import { Session } from "./session.ts";
import { ensureSetup, loadState, type State } from "./setup.ts";

function configOrExit(): Config {
  try {
    return loadConfig();
  } catch (err) {
    console.error(err instanceof ConfigError ? err.message : err);
    process.exit(2);
  }
}
const config = configOrExit();
logToDir(config.dataDir);

const byName = new Map(COMMANDS.map((c) => [c.data.name, c]));
const journal = new Journal(join(config.dataDir, "journal.jsonl"));
let state: State = loadState(config.dataDir);
const audit = new Audit(() => state.logChannelId);
const bountyStore = new BountyStore(join(config.dataDir, "bounty.json"));
const github = config.githubToken ? new GitHub(config.githubToken, config.githubRepo) : null;

/** File a confirmed report on GitHub and remember where. Returns an extra line for the report's thread, if any. */
async function fileOnGitHub(_guild: Guild, report: Report): Promise<string | null> {
  if (!github) return null;
  const kind = report.security ? "advisory" : "issue";
  const url = report.security ? await github.fileAdvisory(report) : await github.fileIssue(report);
  bountyStore.update(report.id, { github: { kind, url } });
  log.info(`Filed bug report #${report.id} as GitHub ${kind} ${url}`);
  // The report's status line already carries the link; say only what it means.
  return report.security ? "The advisory is private to the maintainers until the fix is published, with credit." : null;
}

const feed = config.feed ? new GitHubFeed(config.githubRepo, config.githubToken, join(config.dataDir, "feed.json")) : null;

async function sendFeedPost(guild: Guild, post: FeedPost): Promise<void> {
  const id = post.target === "releases" ? state.releasesChannelId : state.githubChannelId;
  const channel = id ? guild.channels.cache.get(id) : undefined;
  if (!channel?.isTextBased()) return;
  const e = post.embed;
  const embed = new EmbedBuilder().setTitle(e.title).setURL(e.url).setColor(e.color).setAuthor({ name: e.author, url: `https://github.com/${e.author}` }).setTimestamp(new Date(e.timestamp));
  if (e.description) embed.setDescription(e.description);
  if (e.footer) embed.setFooter({ text: e.footer });
  await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
}

/** Poll GitHub forever. A failed poll or post is logged and tried again on the next round. */
async function runFeed(guild: Guild): Promise<void> {
  if (!feed) return;
  for (;;) {
    try {
      for (const { id, posts } of await feed.poll()) {
        for (const post of posts) {
          // One bad post (a deleted channel, a Discord hiccup) must not hold up the rest of the feed.
          await sendFeedPost(guild, post).catch((err) => log.error(`GitHub feed: could not post "${post.embed.title}"`, err));
        }
        feed.markPosted(id);
      }
    } catch (err) {
      log.warn(`GitHub feed: ${err instanceof Error ? err.message : String(err)}; trying again in ${feed.interval}s.`);
    }
    await new Promise((resolve) => setTimeout(resolve, feed.interval * 1000));
  }
}

const bountyDeps = (): BountyDeps => ({ store: bountyStore, audit, adminRoleId: state.adminRoleId, onAccepted: fileOnGitHub });
let ready = false;

const client = new Client({
  // GuildMembers is a privileged intent: turn on "Server Members Intent" in the Developer Portal.
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

/** Anvil serves one server. It leaves any other server it is added to. */
async function enforceHomeGuild(guild: Guild): Promise<boolean> {
  if (guild.id === config.guildId) return true;
  log.warn(`Leaving ${guild.name} (${guild.id}): Anvil only serves GUILD_ID ${config.guildId}.`);
  await guild.leave().catch((err) => log.error(`Could not leave ${guild.id}`, err));
  return false;
}

function rulesFor(guild: Guild): Rules {
  const me = guild.members.me!;
  return {
    adminRoleId: state.adminRoleId,
    botId: me.id,
    botTopRolePosition: me.roles.highest.position,
    logChannelId: state.logChannelId,
  };
}

client.once(Events.ClientReady, async (c) => {
  log.info(`Signed in as ${c.user.tag} (application ${c.application.id}).`);
  if (!config.guildId) {
    const list = c.guilds.cache.map((g) => `${g.name} = ${g.id}`).join("; ") || "none yet";
    log.error(`GUILD_ID is not set, so Anvil will not act anywhere. Servers it is in: ${list}. Set GUILD_ID and restart.`);
    return;
  }
  for (const guild of c.guilds.cache.values()) await enforceHomeGuild(guild);
  const home = c.guilds.cache.get(config.guildId);
  if (!home) {
    log.error(`Anvil is not in server ${config.guildId} yet. Invite it with the link in the README, then restart.`);
    return;
  }
  try {
    state = await ensureSetup(home, config, state);
    await home.commands.set(COMMANDS.map((cmd) => cmd.data.toJSON()));
    c.user.setPresence({ activities: [{ name: "/anvil status", type: ActivityType.Listening }] });
    ready = true;
    log.info(`Ready in ${home.name}: ${COMMANDS.length} commands registered.`);
    log.info(github ? `Confirmed bug reports are filed in ${github.repo}.` : "No GitHub token, so confirmed bug reports are not filed on GitHub.");
    log.info(feed ? `GitHub feed: posting ${feed.repo} to #releases and #github.` : "GitHub feed is off (FEED=off).");
    await audit.note(home, `Anvil started and registered ${COMMANDS.length} commands.`);
    void runFeed(home);
  } catch (err) {
    log.error("Setup failed; Anvil will not take commands until it is restarted", err);
  }
});

client.on(Events.GuildCreate, (guild) => {
  void enforceHomeGuild(guild);
});

client.on(Events.InteractionCreate, async (interaction) => {
  // Bug bounty buttons, menus and forms outlive the command that showed them.
  if ((interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit()) && interaction.customId.startsWith("bounty:")) {
    if (!ready || !interaction.inCachedGuild() || interaction.guildId !== config.guildId) return;
    await handleBountyComponent(interaction, actorOf(interaction.member, state.adminRoleId), bountyDeps());
    return;
  }
  // Other buttons and forms are answered by the command that showed them.
  if (!interaction.isChatInputCommand() && !interaction.isAutocomplete()) return;
  const command = byName.get(interaction.commandName);
  if (!interaction.inCachedGuild() || interaction.guildId !== config.guildId || !command) {
    if (interaction.isAutocomplete()) await interaction.respond([]).catch(() => undefined);
    else await interaction.reply({ content: "Anvil only works in the AnvilCAD server.", flags: MessageFlags.Ephemeral }).catch(() => undefined);
    return;
  }
  const actor = actorOf(interaction.member, state.adminRoleId);
  const refusal = !ready ? "Anvil is still starting up. Try again in a moment." : command.public ? null : checkAuthorised(actor);

  if (interaction.isAutocomplete()) {
    if (refusal || !command.autocomplete) await interaction.respond([]).catch(() => undefined);
    else await command.autocomplete(interaction).catch((err) => log.error("Autocomplete failed", err));
    return;
  }

  const label = `/${[interaction.commandName, interaction.options.getSubcommand(false)].filter(Boolean).join(" ")}`;
  if (refusal) {
    await interaction.reply({ content: refusal, flags: MessageFlags.Ephemeral }).catch(() => undefined);
    if (ready) await audit.refused(interaction.guild, actor.id, interaction.user.tag, label, refusal);
    return;
  }

  const session = new Session(interaction, actor, rulesFor(interaction.guild), { journal, audit, bounty: bountyDeps() });
  try {
    if (!command.usesModal?.(interaction)) await session.defer();
    await command.execute(session);
  } catch (err) {
    const message = describeError(err);
    if (err instanceof UserError) await audit.refused(interaction.guild, actor.id, interaction.user.tag, label, message);
    else log.error(`${label} failed for ${interaction.user.tag}`, err);
    await session.say(message).catch(() => undefined);
  }
});

client.on(Events.Error, (err) => log.error("Discord client error", err));
process.on("unhandledRejection", (err) => log.error("Unhandled rejection", err));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log.info(`Stopping on ${signal}.`);
    void client.destroy().finally(() => process.exit(0));
  });
}

await client.login(config.token);
