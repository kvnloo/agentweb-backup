/**
 * ENG-2110: pure parsing helpers for the `claude auth login` ceremony, shared by the backend's local login
 * runner (B3) and the login host's Claude adapter. Nothing here touches a process, a file or a credential.
 */

/** The code the user pastes back: `<code>#<state>`. */
export const CODE_PATTERN = /^[A-Za-z0-9._~-]{8,200}#[A-Za-z0-9._~-]{8,200}$/;

/** Cap on the output kept while waiting for the URL (the CLI prints a few hundred characters). */
export const MAX_LOGIN_OUTPUT_CHARS = 16_384;

const AUTHORIZE_URL = /https:\/\/claude\.com\/cai\/oauth\/authorize[^\s"'<>]*/;
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/** The authorize URL in the CLI's output, or undefined while it has not been printed yet. */
export function extractAuthorizeUrl(output: string): string | undefined {
  return stripAnsi(output).match(AUTHORIZE_URL)?.[0];
}
