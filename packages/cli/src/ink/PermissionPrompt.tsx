import React from 'react';
import { Box, Text } from 'ink';
import SelectInput from 'ink-select-input';
import type { PermissionChoice, PermissionClass } from '@heapcode/core';

export interface PermissionRequest {
  description: string;
  permission: PermissionClass;
  allowPersist: boolean;
}

function permissionLabel(p: PermissionClass): string {
  switch (p) {
    case 'write':
      return 'modify files';
    case 'execute':
      return 'run a command';
    case 'destructive':
      return 'perform a DESTRUCTIVE action';
    default:
      return p;
  }
}

/** Terminal equivalent of the extension's Allow Once/Session/Always/Deny modal (packages/vscode/src/agent/permissions.ts). */
export function PermissionPrompt({
  request,
  onChoice,
}: {
  request: PermissionRequest;
  onChoice(choice: PermissionChoice): void;
}): React.ReactElement {
  const items: Array<{ label: string; value: PermissionChoice }> = [
    { label: 'Allow once', value: 'allow' },
    ...(request.allowPersist
      ? ([
          { label: 'Allow for this session', value: 'session' as const },
          { label: 'Always allow', value: 'always' as const },
        ] as const)
      : []),
    { label: 'Deny', value: 'deny' },
  ];

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginBottom={1}>
      <Text color="yellow" bold>
        Agent wants to {permissionLabel(request.permission)}
      </Text>
      <Text>{request.description}</Text>
      <Box marginTop={1}>
        <SelectInput items={items} onSelect={(item) => onChoice(item.value)} />
      </Box>
    </Box>
  );
}
