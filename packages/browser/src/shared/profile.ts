import type { Control } from './snapshot.js';

/**
 * The details the user is tired of typing.
 *
 * Filling in a form was the task heapbrowse was best at and slowest at: every
 * field the page wanted and the page did not already know became an `ask_user`
 * round trip, so a nine-field application was nine questions and nine model
 * calls to learn things the user had told it twice already that week.
 *
 * Three rules shape the whole design.
 *
 * **The model never sees a value.** It is told which details exist — "email
 * address", "phone number" — and refers to them by name. The substitution
 * happens here, in the executor, after the permission decision. A page that
 * talks the model into dumping the user's address into a summary cannot,
 * because the model does not have it. (The value does become visible to the
 * next `read_page` once it is in a field, which is unavoidable and no different
 * from the user typing it: it is on their screen either way.)
 *
 * **Nothing is filled that the user did not save.** There is no inference, no
 * "close enough" guess at a field the profile has no entry for. An empty entry
 * is reported as unfilled, and the model asks.
 *
 * **A credential is never a detail.** No password, one-time code or card number
 * lives here, and the matcher refuses fields marked sensitive before it even
 * looks at what they are called. The executor refuses them again after that.
 */

export interface ProfileFieldDef {
  key: string;
  /** What the user sees in Settings, and what the model is told exists. */
  label: string;
  placeholder?: string;
  multiline?: boolean;
  /** `autocomplete` tokens that mean this field, the most reliable signal there is. */
  autocomplete: string[];
  /** Words in a field's own label that mean this, when there is no autocomplete. */
  match: RegExp;
}

/**
 * Ordered as a form asks for them, because that is the order the user will read
 * them in Settings and the order in which a half-filled profile is still useful.
 */
export const PROFILE_FIELDS: readonly ProfileFieldDef[] = [
  {
    key: 'fullName',
    label: 'Full name',
    placeholder: 'Ada Lovelace',
    autocomplete: ['name'],
    match: /\b(full\s*name|your\s*name|name)\b/i,
  },
  {
    key: 'firstName',
    label: 'First name',
    autocomplete: ['given-name'],
    match: /\b(first\s*name|given\s*name|forename)\b/i,
  },
  {
    key: 'lastName',
    label: 'Last name',
    autocomplete: ['family-name'],
    match: /\b(last\s*name|family\s*name|surname)\b/i,
  },
  {
    key: 'email',
    label: 'Email address',
    placeholder: 'you@example.com',
    autocomplete: ['email'],
    match: /\b(e-?mail)\b/i,
  },
  {
    key: 'phone',
    label: 'Phone number',
    autocomplete: ['tel', 'tel-national'],
    match: /\b(phone|mobile|telephone|contact\s*number)\b/i,
  },
  {
    key: 'addressLine1',
    label: 'Street address',
    autocomplete: ['street-address', 'address-line1'],
    match: /\b(street|address(\s*line)?\s*1?|address)\b/i,
  },
  {
    key: 'addressLine2',
    label: 'Address line 2',
    autocomplete: ['address-line2'],
    match: /\b(address\s*line\s*2|apartment|suite|unit)\b/i,
  },
  { key: 'city', label: 'City', autocomplete: ['address-level2'], match: /\b(city|town)\b/i },
  {
    key: 'region',
    label: 'State or region',
    autocomplete: ['address-level1'],
    match: /\b(state|province|region|county)\b/i,
  },
  {
    key: 'postcode',
    label: 'Postcode or ZIP',
    autocomplete: ['postal-code'],
    match: /\b(post\s*code|postal\s*code|zip)\b/i,
  },
  {
    key: 'country',
    label: 'Country',
    autocomplete: ['country', 'country-name'],
    match: /\bcountry\b/i,
  },
  {
    key: 'linkedin',
    label: 'LinkedIn URL',
    placeholder: 'https://linkedin.com/in/…',
    autocomplete: [],
    match: /\blinked\s*in\b/i,
  },
  {
    key: 'github',
    label: 'GitHub URL',
    autocomplete: [],
    match: /\b(git\s*hub|repository|repo)\b/i,
  },
  {
    key: 'website',
    label: 'Website or portfolio',
    autocomplete: ['url'],
    match: /\b(website|portfolio|personal\s*site|url|homepage)\b/i,
  },
  {
    key: 'currentTitle',
    label: 'Current job title',
    autocomplete: ['organization-title'],
    match: /\b(job\s*title|current\s*(role|title|position)|occupation)\b/i,
  },
  {
    key: 'currentCompany',
    label: 'Current employer',
    autocomplete: ['organization'],
    match: /\b(company|employer|organisation|organization)\b/i,
  },
  {
    key: 'yearsExperience',
    label: 'Years of experience',
    autocomplete: [],
    match: /\byears?\s*(of\s*)?experience\b/i,
  },
  {
    key: 'noticePeriod',
    label: 'Notice period',
    autocomplete: [],
    match: /\b(notice\s*period|availability|available\s*from|start\s*date)\b/i,
  },
  {
    key: 'expectedSalary',
    label: 'Expected salary',
    autocomplete: [],
    match: /\b(expected\s*(salary|compensation)|salary\s*expectation|desired\s*salary)\b/i,
  },
  {
    key: 'workAuthorisation',
    label: 'Work authorisation',
    autocomplete: [],
    match: /\b(work\s*(authorisation|authorization|permit|visa)|right\s*to\s*work|sponsorship)\b/i,
  },
  {
    key: 'resume',
    label: 'CV or résumé text',
    placeholder: 'Pasted plain text of your CV, for "tell us about yourself" boxes.',
    multiline: true,
    autocomplete: [],
    match: /\b(r[ée]sum[ée]|cv|about\s*(you|yourself)|summary|bio(graphy)?|experience)\b/i,
  },
  {
    key: 'coverLetter',
    label: 'Cover letter',
    multiline: true,
    autocomplete: [],
    match: /\b(cover\s*letter|motivation|why\s*(do\s*you|are\s*you))\b/i,
  },
] as const;

export type UserProfile = Record<string, string>;

const PROFILE_KEY = 'heapbrowse.userProfile';
const ENABLED_KEY = 'heapbrowse.userProfileEnabled';

export async function loadUserProfile(): Promise<UserProfile> {
  const stored = await chrome.storage.local.get(PROFILE_KEY);
  const profile = stored[PROFILE_KEY];
  if (!profile || typeof profile !== 'object') return {};

  const clean: UserProfile = {};
  for (const field of PROFILE_FIELDS) {
    const value = (profile as Record<string, unknown>)[field.key];
    if (typeof value === 'string' && value.trim()) clean[field.key] = value.trim();
  }
  return clean;
}

export async function saveUserProfile(profile: UserProfile): Promise<void> {
  const clean: UserProfile = {};
  for (const field of PROFILE_FIELDS) {
    const value = profile[field.key];
    if (typeof value === 'string' && value.trim()) clean[field.key] = value.trim();
  }
  await chrome.storage.local.set({ [PROFILE_KEY]: clean });
}

/**
 * The master switch, on by default once details exist.
 *
 * Saving your address into a box labelled "details the agent may use" is the
 * opt-in; a second checkbox asking whether you meant it would be theatre. The
 * switch is here so it can be turned off for one session without deleting
 * anything — which is a real thing to want on a shared machine.
 */
export async function loadProfileEnabled(): Promise<boolean> {
  const stored = await chrome.storage.local.get(ENABLED_KEY);
  return stored[ENABLED_KEY] !== false;
}

export async function saveProfileEnabled(value: boolean): Promise<void> {
  await chrome.storage.local.set({ [ENABLED_KEY]: value });
}

/** The details that are actually filled in, as labels. Never values. */
export function availableLabels(profile: UserProfile): string[] {
  return PROFILE_FIELDS.filter((field) => profile[field.key]).map((field) => field.label);
}

export function fieldByKey(key: string): ProfileFieldDef | undefined {
  return PROFILE_FIELDS.find((field) => field.key === key);
}

/**
 * Which saved detail, if any, belongs in this field.
 *
 * `autocomplete` first and alone when present: it is the page telling us
 * outright what it wants, it is standardised, and it is right far more often
 * than any reading of a label. Only when the page has not said do we fall back
 * to matching what the field is called.
 *
 * The ordering of `PROFILE_FIELDS` carries weight in that fallback — "First
 * name" is tested before the looser "name" pattern, so a form with separate
 * first and last name boxes does not put the full name in both.
 */
export function matchProfileField(control: Control, profile: UserProfile): string | undefined {
  // Never a credential, whatever it is called. The executor refuses these too;
  // this is the earlier of the two refusals and the one that keeps a saved
  // detail from ever being *considered* for a password box.
  if (control.sensitive) return undefined;
  if (control.role !== 'input' && control.role !== 'textarea' && control.role !== 'select') {
    return undefined;
  }

  const tokens = (control.autocomplete ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length > 0 && !tokens.includes('off') && !tokens.includes('on')) {
    for (const field of PROFILE_FIELDS) {
      if (!profile[field.key]) continue;
      if (field.autocomplete.some((token) => tokens.includes(token))) return field.key;
    }
    // The page named something we have no entry for. Guessing from the label
    // now would override an explicit statement of intent with a worse signal.
    return undefined;
  }

  const haystack = `${control.name} ${control.context ?? ''}`;
  for (const field of PROFILE_FIELDS) {
    if (!profile[field.key]) continue;
    if (field.match.test(haystack)) return field.key;
  }
  return undefined;
}

/** Every field on the page that a saved detail belongs in. */
export function matchAll(
  controls: Control[],
  profile: UserProfile,
): { control: Control; key: string; label: string; value: string }[] {
  const used = new Set<string>();
  const matches: { control: Control; key: string; label: string; value: string }[] = [];

  for (const control of controls) {
    const key = matchProfileField(control, profile);
    if (!key) continue;
    // One detail fills one field. A page with a visible email box and a hidden
    // duplicate would otherwise be reported as two fills, and the second is
    // usually the one that breaks something.
    if (used.has(key)) continue;
    used.add(key);
    matches.push({
      control,
      key,
      label: fieldByKey(key)?.label ?? key,
      value: profile[key]!,
    });
  }
  return matches;
}
