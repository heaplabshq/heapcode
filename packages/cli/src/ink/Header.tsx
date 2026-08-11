import React from 'react';
import { Box, Text } from 'ink';

export interface HeaderProps {
  version?: string;
  profileName: string;
  model: string;
  baseUrl?: string;
  cwd?: string;
  /** User/assistant messages in the conversation this session opens with —
   * drives the "continuing" line vs. the getting-started tips. */
  messageCount?: number;
  /** Earlier conversations exist in this project — worth a /resume hint on a fresh start. */
  canResume?: boolean;
}

/** Session banner printed once at the top of the transcript (and again after /new or /resume). */
export function Header({ version, profileName, model, baseUrl, cwd, messageCount = 0, canResume }: HeaderProps): React.ReactElement {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box borderStyle="round" borderColor="cyan" paddingX={2} alignSelf="flex-start">
        <Text>
          <Text color="cyan" bold>
            ◆ heapcode
          </Text>
          {version ? <Text dimColor> v{version}</Text> : null}
        </Text>
      </Box>
      <Box flexDirection="column" paddingLeft={1}>
        <Text dimColor>
          model: {model} · profile: {profileName}
          {baseUrl ? ` @ ${baseUrl}` : ''}
        </Text>
        {cwd ? <Text dimColor>cwd: {cwd}</Text> : null}
      </Box>
      {messageCount > 0 ? (
        <Box paddingLeft={1}>
          <Text dimColor>
            ↩ continuing last conversation ({messageCount} message{messageCount === 1 ? '' : 's'}) · /new to start fresh · /resume to
            switch
          </Text>
        </Box>
      ) : (
        <Box flexDirection="column" paddingLeft={1} marginTop={1}>
          <Text bold>Tips for getting started</Text>
          <Text dimColor> 1. Ask about this codebase, or describe what to build — the agent reads, edits, and runs things with your permission</Text>
          <Text dimColor> 2. Be specific: “add a /health endpoint returning 200” beats “improve the server”</Text>
          <Text dimColor> 3. Shift+Tab cycles permission modes: Plan → Confirm → Auto-edit → Auto (shown bottom-left)</Text>
          <Text dimColor> 4. /help for commands · /model switches models · Esc interrupts · Ctrl+C twice exits</Text>
          {canResume ? <Text dimColor> ↩ earlier conversations exist — /resume continues one (or launch with --continue)</Text> : null}
        </Box>
      )}
    </Box>
  );
}
