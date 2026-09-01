import type { PermissionClass, ToolCall } from './tools.js';

/**
 * Whether a shell command is about to do something that cannot be undone.
 *
 * `run_command` is declared `permission: 'execute'` once, statically, for every
 * command it will ever run — so `resolvePermission('execute', 'full-auto')`
 * returns `allow` for `ls` and for `rm -rf src` alike. The result was a gate
 * that stopped `delete_file` from removing one file while the shell removed the
 * whole tree unasked, which is exactly backwards: the shell is the more
 * dangerous of the two, not the less.
 *
 * Every published agent solves this the same way — the unit of permission is
 * the *command*, not the tool. Claude Code matches command patterns
 * (`Bash(npm run test:*)`), Copilot's agent mode ships a default deny list of
 * `rm`/`kill`/`curl`/`chmod` and friends, Cursor keeps allow and deny prefix
 * lists. This is the deny half of that, which is the half that has to exist:
 * an allowlist that is missing an entry costs a prompt, a denylist that is
 * missing an entry costs the user their work.
 *
 * NOT A SECURITY BOUNDARY, and nothing downstream should treat it as one. A
 * command is an arbitrary string handed to a real shell — `eval`, an alias, a
 * variable holding the verb, base64 into `sh`, or plain unusual quoting all
 * defeat a regex, and no amount of pattern-writing changes that. What this
 * does defend against is the threat actually on hand: a capable model, acting
 * in good faith, confidently running the wrong destructive command. A speed
 * bump is the right shape for that and the wrong shape for an adversary.
 */

/**
 * Deliberately matched against the whole command rather than each part of a
 * pipeline.
 *
 * Chained commands are why allowlists have to decompose — `ls && rm -rf /`
 * passes any check that only reads the first verb. A denylist inverts the
 * burden: *any* part matching is enough to escalate, so anchoring each pattern
 * on a separator (start of string, `;`, `&&`, `|`, newline, or the opening of a
 * `$(…)`) catches the tail of a chain without the loop that walks it. The
 * escapes that beat this beat decomposition too — see the header.
 */
const SEP = String.raw`(?:^|[\s;&|(){}]|\$\()`;

const IRREVERSIBLE: readonly { re: RegExp; why: string }[] = [
  // Deleting files outright. Every `rm`, not just `-rf`: the session
  // checkpoint only covers changes made through the file tools, so anything
  // the shell unlinks is gone in a way the user cannot rewind.
  { re: new RegExp(`${SEP}(?:rm|rmdir|unlink|shred)(?:\\s|$)`), why: 'deletes files' },
  { re: new RegExp(`${SEP}truncate\\s`), why: 'truncates a file' },
  // Writing over a block device, or building a filesystem on one.
  { re: new RegExp(`${SEP}(?:mkfs\\S*|fdisk|diskutil)(?:\\s|$)`), why: 'writes to a disk device' },
  { re: new RegExp(`${SEP}dd\\s[^|;&]*\\bof=`), why: 'writes a raw image over a target' },
  // Throwing away work that is not committed anywhere.
  { re: new RegExp(`${SEP}git\\s+reset\\s+[^|;&]*--hard`), why: 'discards uncommitted work' },
  { re: new RegExp(`${SEP}git\\s+clean\\s+[^|;&]*-[a-z]*[fdx]`), why: 'deletes untracked files' },
  // Rewriting a shared history. --force-with-lease is the careful spelling of
  // the same act and belongs here too: it is still a remote branch that other
  // people's clones no longer match.
  { re: new RegExp(`${SEP}git\\s+push\\b[^|;&]*(?:--force|\\s-f(?:\\s|$))`), why: 'rewrites a remote branch' },
  { re: new RegExp(`${SEP}git\\s+(?:branch|tag)\\s+[^|;&]*-D`), why: 'deletes a ref' },
  // Publishing: cannot be recalled once it has left the machine, and an
  // unpublish is its own incident.
  { re: new RegExp(`${SEP}(?:npm|yarn|pnpm|bun)\\s+publish(?:\\s|$)`), why: 'publishes a package' },
  { re: new RegExp(`${SEP}cargo\\s+publish(?:\\s|$)`), why: 'publishes a crate' },
  { re: new RegExp(`${SEP}(?:twine\\s+upload|gem\\s+push)(?:\\s|$)`), why: 'publishes a package' },
  { re: new RegExp(`${SEP}gh\\s+release\\s+(?:create|delete)(?:\\s|$)`), why: 'changes a public release' },
  // Tearing down infrastructure.
  { re: new RegExp(`${SEP}kubectl\\s+delete(?:\\s|$)`), why: 'deletes a cluster resource' },
  { re: new RegExp(`${SEP}(?:docker|podman)\\s+(?:system\\s+)?prune(?:\\s|$)`), why: 'prunes container state' },
  { re: new RegExp(`${SEP}terraform\\s+(?:destroy|apply)(?:\\s|$)`), why: 'changes real infrastructure' },
  // Running code straight off the network, which is unreviewable by anyone.
  { re: /(?:curl|wget)[^|;&]*\|\s*(?:sudo\s+)?(?:ba|z|k|d)?sh/, why: 'pipes a download into a shell' },
  // Privilege escalation: whatever follows, the user should see it first.
  { re: new RegExp(`${SEP}sudo(?:\\s|$)`), why: 'runs as root' },
];

/** Why this command was escalated, or undefined when nothing matched. */
export function irreversibleReason(command: string): string | undefined {
  return IRREVERSIBLE.find(({ re }) => re.test(command))?.why;
}

export function looksIrreversible(command: string): boolean {
  return irreversibleReason(command) !== undefined;
}

/**
 * Tools whose real risk lives in an argument rather than in the tool itself.
 * Both spawn a shell (workspaceTools.ts `runCommand`), so both need reading.
 */
const COMMAND_ARG_TOOLS: Record<string, string> = {
  run_command: 'command',
  run_tests: 'command',
};

/**
 * The permission class a call should actually be judged at.
 *
 * Idempotent, and safe to apply more than once on the way to a decision — the
 * server stamps it onto the wire for hosts that cannot see a tool definition
 * (headless, web-host), and PermissionEngine applies it again for the hosts
 * that look their own definitions up. Escalation only ever goes one way: a
 * declared class is never lowered.
 */
export function effectivePermission(call: ToolCall, declared: PermissionClass): PermissionClass {
  if (declared === 'destructive') return declared;
  const argName = COMMAND_ARG_TOOLS[call.name];
  if (!argName) return declared;
  const command = call.args[argName];
  if (typeof command !== 'string' || !command) return declared;
  return looksIrreversible(command) ? 'destructive' : declared;
}
