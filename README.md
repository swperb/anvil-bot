# Anvil

Anvil is the admin bot for the [AnvilCAD](https://github.com/swperb/anvilcad) Discord server. It
changes the server through slash commands: channels, categories, roles, permissions, messages,
server settings and members. Every change is logged and almost every one can be undone.

It serves one server only, takes commands only from the server owner and members with the
**Anvil Admin** role, asks before anything destructive, and costs nothing to run.

## Commands

Every reply from Anvil is private to the person who ran the command.

| Command | What it does | Asks first | `/undo` |
|---|---|---|---|
| `/channel create` | Text, voice, category, announcement, forum or stage channel; optional category, topic, private | | deletes it |
| `/channel edit` | Name, topic, category, slowmode, age restriction, position | | puts it back |
| `/channel delete` | Channel or category | yes | recreates it with its permissions (not its messages) and moves child channels back |
| `/role create` / `edit` | Name, colour, permissions, hoist, mentionable, position | | deletes it / puts it back |
| `/role delete` | | yes | recreates it, gives it back to the same members, restores its channel permissions |
| `/role give` / `take` | | | reverses it |
| `/perm set` | Allow, deny or reset permissions for a role or member in a channel or category | | puts the overrides back |
| `/perm clear` / `sync` / `show` | Remove overrides, sync with the category, list overrides | | puts the overrides back |
| `/message send` / `edit` | Post or edit a message as Anvil; leave `text` empty for a multi-line form | | deletes it / restores the old text |
| `/message delete` / `purge` | One message, or up to 100 recent ones (optionally from one person) | yes | not possible |
| `/message pin` / `unpin` | | | reverses it |
| `/server info` / `edit` | Name, description, icon, verification, notifications, system/rules/AFK channels | | puts them back |
| `/member nick` / `timeout` / `untimeout` | | | reverses nick and timeout |
| `/member kick` | | yes | not possible |
| `/member ban` / `unban` | | ban: yes | reverses it |
| `/undo [id]` | Undo your latest change, or change `id` | when the undo deletes something | |
| `/history [count]` | Recent changes with their numbers | | |
| `/anvil status` | Who can command Anvil, and which roles could give themselves that power | | |

Permission names are Discord's (`ViewChannel, SendMessages`) or the ones shown in Discord's
settings (`Manage Permissions`); the option suggests names as you type.

## Who can command it

- **The server owner**, always.
- **Members with the Anvil Admin role.** Anvil creates this role on first start and remembers it
  by ID, so renaming another role to "Anvil Admin" grants nothing. Give it to people in
  Server Settings > Members.
- **Nobody else**, whatever their Discord permissions. Refusals are logged.

Anvil Admins cannot use Anvil to gain power: they cannot grant Administrator, grant permissions
they do not hold themselves, change the Anvil Admin role or any role with Administrator, act on
roles at or above their own highest role, or act on the owner, on themselves, on Anvil, or on
members ranked at or above them. Only the owner can undo someone else's change or delete
`#anvil-log`.

Discord itself lets anyone with **Manage Roles** above the Anvil Admin role, or with
**Administrator**, give themselves that role. `/anvil status` lists those roles; give them only to
people you would trust with Anvil.

Slash commands are hidden from members without Administrator. To let Anvil Admins who lack
Administrator see them, open Server Settings > Integrations > Anvil and allow the Anvil Admin
role.

## The audit log

Every change, refusal, cancelled confirmation and start-up goes to the private `#anvil-log`
channel (readable by the owner, Administrators and Anvil Admins; only Anvil can post) and to
`anvil.log` in the data folder. The journal behind `/undo` and `/history` is
`journal.jsonl` in the same folder: one JSON object per line, readable by hand. Discord's own
audit log also records each change with the reason "Anvil, for <name>".

## Running it

Anvil runs on the TrueNAS box as a custom Docker app, managed by `scripts/nas.sh` from a Mac or
Linux machine that can SSH to the NAS as a user with TrueNAS middleware access.

Settings live outside the repository in `~/.config/anvil-bot/nas.env` (mode 600):

```sh
NAS_HOST=your-truenas-host
NAS_USER=truenas_admin
NAS_DATASET=pool/anvil-bot
GUILD_ID=the-server-id
```

```bash
scripts/nas.sh setup      # once: dataset and folders
scripts/nas.sh token      # store the token (see below)
scripts/nas.sh deploy     # copy the code and start or update the app
scripts/nas.sh status
scripts/nas.sh logs 100
scripts/nas.sh restart
```

The dataset holds three folders. `app/` has the code and its dependencies, mounted read-only.
`secrets/` has the token, mode 640, readable only by the container's group. `data/` has the
journal, state and log, and is the only place the container can write.

The container is locked down (see `deploy/compose.yaml`):

- It publishes no ports; Anvil only connects out to Discord.
- It runs as TrueNAS's unprivileged `apps` user (568) with every Linux capability dropped and
  `no-new-privileges`.
- Its root filesystem is read-only.
- It is capped at 256 MB of memory, half a CPU and 100 processes.
- The Node image is pinned by digest, so a changed upstream image is never pulled silently.
  To update it, look up the new digest of `node:24-alpine` and change `IMAGE` in
  `scripts/nas.sh`.

### On your own machine

For development, with Node 24 or later:

```bash
npm ci
cp .env.example .env    # then set GUILD_ID and put the token in ./secrets/discord_token
npm start
```

Use a separate test server and a separate bot application for this, so you never run two
copies against the real server.

## The token

The bot token is a password for the bot account. Anyone holding it can do anything Anvil can.

- It is read from the file `DISCORD_TOKEN_FILE` names (or `DISCORD_TOKEN`), and never logged.
- `.env`, `secrets/` and `*.token` are git-ignored. Never commit it, paste it into an issue or
  chat, or put it in `compose.yaml`.
- `scripts/nas.sh token` asks for it without echoing and writes it straight to the NAS, so it
  never lands in shell history or a local file.

### Rotating it

Do this if the token may have leaked, and from time to time anyway:

1. In the [Developer Portal](https://discord.com/developers/applications), open Anvil > Bot and
   click **Reset Token**. The old token stops working at once.
2. Run `scripts/nas.sh token` and paste the new one.
3. Run `scripts/nas.sh restart`, then check `scripts/nas.sh logs` for "Ready in ...".

## Setting up the Discord application (once)

1. In the Developer Portal, create an application named Anvil.
2. On **Installation**, set Install Link to None.
3. On **Bot**: turn off **Public Bot** (only you can add it to servers), and turn on
   **Server Members Intent** (needed to restore a deleted role's members). Leave the other
   intents off.
4. Store the token as above.
5. Invite it with Administrator to your server, replacing the two IDs:
   `https://discord.com/oauth2/authorize?client_id=APPLICATION_ID&scope=bot+applications.commands&permissions=8&guild_id=SERVER_ID&disable_guild_select=true`
6. In Server Settings > Roles, drag Anvil's role near the top. Discord only lets it manage roles
   and members below it.

Anvil leaves any server other than `GUILD_ID`.

## Adding a command

1. Create `src/commands/<name>.ts` exporting a `Command` (see `src/command.ts`). Build its
   definition with `slash(name, description)` so it is server-only and hidden from non-admins.
2. In `execute(session)`:
   - Check targets with `requireRole`, `requireMember` and `refuse(checkGrant(...))` from
     `src/command.ts` and `src/auth.ts`.
   - For anything destructive, `if (!(await session.confirm("..."))) return;`.
   - Make the change with a `reason`.
   - Finish with `session.done(summary, undoOp)`. That records the change in the journal and
     the log and tells the person.
   - Throw `UserError` for anything the person should fix.
3. To make it undoable, add a case to `UndoOp` in `src/journal.ts` and to `describeUndo` and
   `runUndo` in `src/undo.ts`. TypeScript reports any case you miss.
4. Add it to `COMMANDS` in `src/commands/index.ts` and to the table above.
5. Run `npm run check` and `npm test`, then `scripts/nas.sh deploy`. Commands are registered on
   start-up.

Larger features can live in their own folder under `src/` and hook into the client in
`src/index.ts`. For example, a later triage feature could turn messages in a support channel
into GitHub issues. Such a feature needs its own intents (such as Message Content), turned on in
the Developer Portal, and its own credentials, kept like the bot token.

## Development

```bash
npm run check   # TypeScript, strict
npm test        # node:test unit tests: permissions, authorisation rules, journal, config, command definitions
```

The code is TypeScript run directly by Node 24's type stripping, so there is no build step.
Use only erasable syntax: no enums, namespaces or parameter properties.

## Licence

MIT. See [LICENSE](LICENSE).
