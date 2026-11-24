import { DiscordAPIError, RESTJSONErrorCodes } from "discord.js";

/** An error whose message is written for the person who ran the command. */
export class UserError extends Error {
  override name = "UserError";
}

/** Turn any thrown value into a sentence that says what went wrong and what to do. */
export function describeError(err: unknown): string {
  if (err instanceof UserError) return err.message;
  if (err instanceof DiscordAPIError) {
    switch (err.code) {
      case RESTJSONErrorCodes.MissingPermissions:
        return (
          "Discord refused: Anvil lacks the permission for that. Check that Anvil's role is " +
          "above the roles and members it is changing (Server Settings > Roles) and that it " +
          "still has Administrator."
        );
      case RESTJSONErrorCodes.MissingAccess:
        return "Discord refused: Anvil cannot see that channel. Give Anvil's role View Channel there.";
      case RESTJSONErrorCodes.UnknownChannel:
        return "That channel no longer exists.";
      case RESTJSONErrorCodes.UnknownRole:
        return "That role no longer exists.";
      case RESTJSONErrorCodes.UnknownMember:
        return "That person is no longer in the server.";
      case RESTJSONErrorCodes.UnknownMessage:
        return "That message no longer exists.";
      case RESTJSONErrorCodes.UnknownBan:
        return "That person is not banned.";
      case RESTJSONErrorCodes.CannotEditMessageAuthoredByAnotherUser:
        return "Discord only lets a bot edit its own messages. Send a new message with /message send.";
      case RESTJSONErrorCodes.MaximumNumberOfGuildChannelsReached:
        return "The server has reached Discord's limit of 500 channels.";
      case RESTJSONErrorCodes.MaximumNumberOfGuildRolesReached:
        return "The server has reached Discord's limit of 250 roles.";
      default:
        return `Discord refused the change: ${err.message} (code ${err.code}). Nothing else was changed.`;
    }
  }
  return "Something went wrong inside Anvil, and the change may not have finished. The details are in Anvil's log; run /history to see what was recorded.";
}
