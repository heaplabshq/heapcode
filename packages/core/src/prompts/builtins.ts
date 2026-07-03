export interface PromptTemplate {
  /** Slash command, without the leading slash. */
  command: string;
  title: string;
  /** `{input}` is replaced with the text after the command. */
  template: string;
}

export const builtinPrompts: readonly PromptTemplate[] = [
  {
    command: 'explain',
    title: 'Explain code',
    template:
      'Explain the following code clearly and concisely. Describe what it does, how it works, and anything non-obvious. {input}',
  },
  {
    command: 'fix',
    title: 'Fix problems',
    template:
      'Find and fix the problems in the following code. Show the corrected code and briefly explain each fix. {input}',
  },
  {
    command: 'refactor',
    title: 'Refactor code',
    template:
      'Refactor the following code to improve readability and maintainability without changing behavior. Show the refactored code and summarize the changes. {input}',
  },
  {
    command: 'review',
    title: 'Review code',
    template:
      'Review the following code as a senior engineer. Point out bugs, edge cases, security issues, and style problems, ordered by severity. {input}',
  },
  {
    command: 'test',
    title: 'Generate tests',
    template:
      "Write thorough unit tests for the following code using the project's likely test framework. Cover edge cases. {input}",
  },
  {
    command: 'docs',
    title: 'Generate documentation',
    template:
      'Write documentation for the following code: doc comments for public APIs plus a short usage example. {input}',
  },
  {
    command: 'optimize',
    title: 'Optimize performance',
    template:
      'Optimize the following code for performance. Explain the bottlenecks you found and show the improved code. {input}',
  },
];

export function findPrompt(
  command: string,
  prompts: readonly PromptTemplate[] = builtinPrompts,
): PromptTemplate | undefined {
  return prompts.find((p) => p.command === command);
}

export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template
    .replace(/\{(\w+)\}/g, (match, name: string) => vars[name] ?? match)
    .trim();
}

/**
 * Splits a chat input like "/explain what does this do" into the matched
 * prompt and remaining input. Returns undefined if it's not a slash command.
 */
export function parseSlashCommand(
  text: string,
  prompts: readonly PromptTemplate[] = builtinPrompts,
): { prompt: PromptTemplate; input: string } | undefined {
  const match = /^\/([\w-]+)\s*([\s\S]*)$/.exec(text.trim());
  if (!match) return undefined;
  const prompt = findPrompt(match[1]!.toLowerCase(), prompts);
  if (!prompt) return undefined;
  return { prompt, input: match[2]!.trim() };
}
