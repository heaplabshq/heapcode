/**
 * What a list says when it has nothing in it.
 *
 * A dashed panel rather than a grey sentence, and the same one in the settings
 * dialog and the workspace panel: an empty list and a list that failed to load
 * looked identical when the only difference between them was a line of dim
 * text.
 */
export function Empty({ children }: { children: React.ReactNode }): JSX.Element {
  return <p className="empty-state">{children}</p>;
}
