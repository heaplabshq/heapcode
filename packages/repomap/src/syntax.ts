/**
 * The structural slice of a tree-sitter syntax tree this package actually
 * reads. Declared here rather than imported from web-tree-sitter so the
 * package carries no parser dependency at all: a host that already has a
 * parser wired up passes one in (see ParserResolver), and everything else
 * falls back to the regex extractors. web-tree-sitter's own `Node`/`Parser`
 * satisfy these shapes structurally, so a host can hand its parser factory
 * over directly with no adapter.
 */
export interface SyntaxNode {
  /** Grammar node type, e.g. "function_declaration". */
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  namedChildren: (SyntaxNode | null)[];
  childForFieldName(fieldName: string): SyntaxNode | null;
}

export interface SyntaxTree {
  rootNode: SyntaxNode;
}

export interface SyntaxParser {
  parse(content: string): SyntaxTree | null;
}

/**
 * Resolves a parser for a file path, or undefined when this host has no
 * grammar for that language (or no parser wired up at all). Undefined is a
 * normal answer, not an error — the caller falls back to the regex
 * extractors, which is what makes this package work with zero parser setup.
 */
export type ParserResolver = (path: string) => Promise<SyntaxParser | undefined>;
