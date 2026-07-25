import type { Node as TSNode } from 'web-tree-sitter';
import { isAstSupported, parserForPath } from '../rag/astChunker.js';

const MAX_CONTENT_LENGTH = 2_000_000;

function findFirstError(node: TSNode): TSNode | undefined {
  if (node.isError || node.isMissing) return node;
  for (const child of node.namedChildren) {
    if (!child) continue;
    const found = findFirstError(child);
    if (found) return found;
  }
  return undefined;
}

/**
 * Parses `content` with the grammar for `path` and reports the first syntax
 * error, if any. Returns undefined (never blocks a write) when the language
 * has no configured grammar, no wasm loader is wired up (configureAstChunker
 * not called), the content is too large, or it parses cleanly.
 */
export async function checkSyntax(path: string, content: string): Promise<string | undefined> {
  if (!isAstSupported(path) || !content.trim() || content.length > MAX_CONTENT_LENGTH) return undefined;
  const parser = await parserForPath(path);
  if (!parser) return undefined;

  let tree;
  try {
    tree = parser.parse(content);
  } catch {
    return undefined;
  }
  if (!tree || !tree.rootNode.hasError) return undefined;

  const errorNode = findFirstError(tree.rootNode);
  const line = (errorNode?.startPosition.row ?? 0) + 1;
  return `Syntax error near line ${line} of ${path}.`;
}
