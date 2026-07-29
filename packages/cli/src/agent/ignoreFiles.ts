/**
 * The workspace ignore rules now live in @heapcode/core, because the server
 * applies the same ones when it indexes the workspace for itself
 * (docs/phase3-rag-design.md §3.2, decision 4). This re-export keeps every
 * existing import path working; the implementation is unchanged byte for
 * byte, it just has one home instead of two.
 */
export { filterIgnored, loadIgnoreMatcher } from '@heapcode/core';
