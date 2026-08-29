import { Icon } from './Icon.js';

/**
 * Which model, as a list when we know one and a text box when we do not.
 *
 * Typing a model name from memory is the step of setup people get wrong most
 * often, and the failure is silent until the first question comes back as a
 * 404 from the provider. The endpoint knows the answer -- the connection check
 * already asks it for `/models`, because that is what makes it a connection
 * check -- so once it has answered, this is a list.
 *
 * It stays a text box when the list is empty, and that is not a fallback so
 * much as the other real case: plenty of gateways serve chat completions
 * perfectly well and list nothing at all. An unlisted name the user has typed
 * is also kept in the list, so switching away from it and back does not
 * silently lose it.
 */
export function ModelField({
  value,
  models,
  onChange,
  placeholder,
}: {
  value: string;
  models: string[];
  onChange: (model: string) => void;
  placeholder?: string;
}) {
  if (models.length === 0) {
    return (
      <label>
        Model
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          spellCheck={false}
        />
        <span className="hint">
          Test the connection and this becomes a list of what the endpoint offers.
        </span>
      </label>
    );
  }

  const known = value && !models.includes(value) ? [value, ...models] : models;

  return (
    <label>
      Model
      <span className="picker">
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          {value === '' && <option value="">Choose a model…</option>}
          {known.map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
        </select>
        <Icon name="chevron" size={12} className="picker-caret" />
      </span>
    </label>
  );
}
