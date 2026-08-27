import type { PermissionClass } from '@heapcode/core/agent';
import { resolvePermission, type PermissionMode } from '@heapcode/core/agent';

/**
 * Permission is f(actionClass, origin), not f(actionClass).
 *
 * heapcode can decide from the class alone because every workspace is the same
 * kind of place -- a git-recoverable working tree. A browser is not: a write on
 * a scratch site and a write on a bank are the same call and completely
 * different decisions (PRD section 6.2). Core supplies the class axis through
 * `resolvePermission`; this adds the origin axis on top rather than replacing
 * it, so the two products keep the same idea of what a class means.
 *
 * There is no `full-auto`. heapcode's most permissive mode still asks before
 * destructive actions because the blast radius is a working tree; here it is
 * the user's money, so the ceiling is auto-write on a site the user has
 * explicitly trusted, and destructive always asks (PRD section 6.3).
 */

/**
 * `auto-approve` applies everywhere, not to one site -- it lifts the prompt for
 * routine actions generally. Per-site trust is the separate `trustedHosts` set,
 * granted by answering "always on this site" at a confirmation. The mode was
 * originally called `trusted-site`, which read as the per-site thing and was
 * not: a label that describes a narrower behaviour than the code has is how a
 * user ends up granting more than they meant to.
 */
export const BROWSER_MODES = ['read-only', 'confirm', 'auto-approve'] as const;
export type BrowserMode = (typeof BROWSER_MODES)[number];

export const DEFAULT_BROWSER_MODE: BrowserMode = 'confirm';

/** Mapped onto core's vocabulary so a class means one thing across products. */
const CORE_MODE: Record<BrowserMode, PermissionMode> = {
  'read-only': 'plan',
  confirm: 'default',
  // Auto-edit allows `write` and still asks for `destructive`, which is exactly
  // the ceiling here. `full-auto` is deliberately never reachable: heapcode's
  // most permissive mode risks a git-recoverable tree, this one risks money.
  'auto-approve': 'auto-edit',
};

/**
 * Sites where the agent may read only, and may never act.
 *
 * Matched on the registrable-ish suffix, so `hdfcbank.com` covers
 * `netbanking.hdfcbank.com`. This is a floor, not a complete list -- it cannot
 * be complete, and pretending otherwise would be the mistake. It exists so the
 * highest-harm categories are not one mis-click of "always allow" away.
 */
const NEVER_ACT = [
  // Banking and payments
  'paypal.com', 'stripe.com', 'wise.com', 'revolut.com', 'chase.com', 'wellsfargo.com',
  'bankofamerica.com', 'citi.com', 'hsbc.com', 'barclays.co.uk', 'lloydsbank.com',
  'hdfcbank.com', 'icicibank.com', 'sbi.co.in', 'axisbank.com', 'kotak.com',
  'onlinesbi.sbi', 'netbanking.hdfcbank.com',
  // Brokerage
  'zerodha.com', 'kite.zerodha.com', 'groww.in', 'upstox.com', 'robinhood.com',
  'schwab.com', 'fidelity.com', 'vanguard.com', 'interactivebrokers.com', 'coinbase.com',
  'binance.com', 'kraken.com',
  // Government and identity
  'gov.uk', 'irs.gov', 'ssa.gov', 'uidai.gov.in', 'incometax.gov.in', 'gov.in',
  // Primary email
  'mail.google.com', 'outlook.live.com', 'outlook.office.com', 'mail.yahoo.com',
  'proton.me', 'mail.proton.me', 'zoho.com',
  // Password managers
  '1password.com', 'lastpass.com', 'bitwarden.com', 'dashlane.com', 'keeper.io',
];

/** True when the host is, or is a subdomain of, a blocklisted site. */
export function isHighHarm(host: string): boolean {
  const lower = host.toLowerCase();
  return NEVER_ACT.some((blocked) => lower === blocked || lower.endsWith(`.${blocked}`));
}

export type Decision =
  | { effect: 'allow' }
  | { effect: 'ask' }
  | { effect: 'deny'; reason: string };

export interface PolicyInput {
  permission: PermissionClass;
  host: string;
  mode: BrowserMode;
  /** The user chose "always allow on this site" for writes, this session. */
  trustedHosts: ReadonlySet<string>;
}

/**
 * The decision, before any prompt is shown.
 *
 * Order matters. The blocklist is checked before the mode, so no combination of
 * settings can act on a bank -- a per-site grant is not offered there at all,
 * which is the point of having a floor.
 */
export function decide(input: PolicyInput): Decision {
  const { permission, host, mode, trustedHosts } = input;

  if (permission === 'read') return { effect: 'allow' };

  if (isHighHarm(host)) {
    return {
      effect: 'deny',
      reason:
        `heapbrowse will not take actions on ${host}. It is a banking, brokerage, government, ` +
        `email or password-manager site, where a mistake is not recoverable. Reading is allowed; ` +
        `acting is not, and this cannot be overridden.`,
    };
  }

  // A trusted site raises the ceiling for writes only. Destructive still asks,
  // because "always allow" was answered about filling a field, not about
  // placing an order.
  const effective: BrowserMode =
    trustedHosts.has(host.toLowerCase()) && mode === 'confirm' ? 'auto-approve' : mode;

  const resolution = resolvePermission(permission, CORE_MODE[effective]);
  if (resolution === 'allow') return { effect: 'allow' };
  if (resolution === 'deny') {
    return {
      effect: 'deny',
      reason:
        mode === 'read-only'
          ? 'heapbrowse is in read-only mode, so it cannot act on the page. Switch modes to allow it.'
          : 'That action is not permitted here.',
    };
  }
  return { effect: 'ask' };
}

/** Whether "always allow on this site" should be offered for this action. */
export function mayOfferAlwaysAllow(permission: PermissionClass, host: string): boolean {
  // Never for destructive: the point of always-allow is to stop asking, and the
  // actions worth asking about are exactly the ones that spend money.
  return permission === 'write' && !isHighHarm(host);
}
