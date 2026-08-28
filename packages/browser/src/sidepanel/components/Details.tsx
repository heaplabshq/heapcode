import { useEffect, useState } from 'react';
import {
  PROFILE_FIELDS,
  loadProfileEnabled,
  loadUserProfile,
  saveProfileEnabled,
  saveUserProfile,
  type UserProfile,
} from '../../shared/profile.js';

/**
 * The details the user is tired of typing into forms.
 *
 * Filling this in is the opt-in; there is no second checkbox asking whether
 * they meant it. The switch exists so the whole set can be turned off for a
 * session without deleting it, which is a real thing to want on a shared
 * machine, and it is honest about what off means: the run does not receive the
 * details at all, rather than receiving them and being asked not to look.
 *
 * Saved on blur rather than behind a Save button. This is a long form nobody
 * will fill in one sitting, and a half-filled profile is useful — a page that
 * only wants a name and an email does not care that the salary box is empty.
 */
export function Details() {
  const [profile, setProfile] = useState<UserProfile>({});
  const [enabled, setEnabled] = useState(true);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void Promise.all([loadUserProfile(), loadProfileEnabled()]).then(([stored, on]) => {
      setProfile(stored);
      setEnabled(on);
      setLoaded(true);
    });
  }, []);

  const set = (key: string, value: string) => setProfile((prev) => ({ ...prev, [key]: value }));
  const persist = () => void saveUserProfile(profile);

  const filled = PROFILE_FIELDS.filter((field) => profile[field.key]?.trim()).length;

  return (
    <div className="details">
      <label className="switch">
        <input
          type="checkbox"
          aria-label="Let heapbrowse use these details"
          checked={enabled}
          onChange={(e) => {
            setEnabled(e.target.checked);
            void saveProfileEnabled(e.target.checked);
          }}
        />
        Let heapbrowse fill these in for you
      </label>
      <p className="muted">
        Stored on this machine only, never synced and never sent to your model. The agent is told
        which of these exist — &ldquo;there is an email address on file&rdquo; — and never sees the
        values: it asks for a field to be filled and heapbrowse fills it in here, after you approve
        the action. {filled > 0 && `${filled} saved.`}
      </p>

      {loaded &&
        PROFILE_FIELDS.map((field) => (
          <label key={field.key}>
            {field.label}
            {field.multiline ? (
              <textarea
                value={profile[field.key] ?? ''}
                onChange={(e) => set(field.key, e.target.value)}
                onBlur={persist}
                placeholder={field.placeholder}
                rows={4}
              />
            ) : (
              <input
                value={profile[field.key] ?? ''}
                onChange={(e) => set(field.key, e.target.value)}
                onBlur={persist}
                placeholder={field.placeholder}
                autoComplete="off"
                spellCheck={false}
              />
            )}
          </label>
        ))}

      <p className="muted">
        Never put a password, a one-time code or a card number here. heapbrowse refuses to type into
        those fields whatever it has been told, and nothing on this page changes that.
      </p>
    </div>
  );
}
