const FENCE = /```[\w+.-]*[ \t]*\r?\n([\s\S]*?)```/;

/**
 * Extracts the first fenced code block from a model response.
 * Edit prompts instruct the model to reply with exactly one block, but models
 * sometimes add prose around it — take the block, ignore the chatter.
 */
export function extractFirstCodeBlock(markdown: string): string | undefined {
  const match = FENCE.exec(markdown);
  if (!match) return undefined;
  return match[1]!.replace(/\r?\n$/, '');
}
