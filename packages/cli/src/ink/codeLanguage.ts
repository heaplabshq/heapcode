const EXTENSION_LANGUAGE: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  swift: 'swift',
  scala: 'scala',
  sh: 'bash',
  bash: 'bash',
  sql: 'sql',
  vue: 'xml',
  svelte: 'xml',
  md: 'markdown',
  yaml: 'yaml',
  yml: 'yaml',
  json: 'json',
  toml: 'ini',
  html: 'xml',
  htm: 'xml',
  css: 'css',
  scss: 'scss',
  sass: 'scss',
  less: 'less',
  xml: 'xml',
  graphql: 'graphql',
  gql: 'graphql',
  lua: 'lua',
  dart: 'dart',
  ex: 'elixir',
  exs: 'elixir',
  tf: 'ini',
  ini: 'ini',
  conf: 'ini',
  dockerfile: 'dockerfile',
};

/** Workspace-relative or absolute path → a cli-highlight/highlight.js language id, or undefined for an unrecognized extension. */
export function languageForPath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const base = path.split(/[/\\]/).pop() ?? path;
  if (/^dockerfile$/i.test(base)) return 'dockerfile';
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1).toLowerCase() : '';
  return EXTENSION_LANGUAGE[ext];
}
