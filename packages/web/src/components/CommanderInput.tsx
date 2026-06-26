import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

/**
 * A text input with commander name type-ahead. Suggestions come from Scryfall
 * (legal commanders, EDHREC-ranked). Debounced; keyboard- and mouse-navigable.
 * `onEnter` fires on Enter only when no suggestion is being selected.
 */
export function CommanderInput({
  value,
  onChange,
  placeholder,
  onEnter,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  onEnter?: () => void;
}) {
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(-1);
  const boxRef = useRef<HTMLDivElement>(null);
  // Don't re-query right after the user picks a suggestion.
  const justChose = useRef(false);

  useEffect(() => {
    if (justChose.current) {
      justChose.current = false;
      return;
    }
    const q = value.trim();
    if (q.length < 2) {
      setSuggestions([]);
      setOpen(false);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      api
        .autocomplete(q)
        .then((r) => {
          if (cancelled) return;
          setSuggestions(r.names);
          setOpen(r.names.length > 0);
          setHi(-1);
        })
        .catch(() => {});
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [value]);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  function choose(name: string) {
    justChose.current = true;
    onChange(name);
    setOpen(false);
    setSuggestions([]);
    setHi(-1);
  }

  return (
    <div className="ac" ref={boxRef}>
      <input
        type="text"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => suggestions.length > 0 && setOpen(true)}
        onKeyDown={(e) => {
          if (open && suggestions.length > 0) {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setHi((h) => Math.min(h + 1, suggestions.length - 1));
              return;
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              setHi((h) => Math.max(h - 1, -1));
              return;
            }
            if (e.key === 'Enter' && hi >= 0) {
              e.preventDefault();
              choose(suggestions[hi]!);
              return;
            }
            if (e.key === 'Escape') {
              setOpen(false);
              return;
            }
          }
          if (e.key === 'Enter') {
            setOpen(false);
            onEnter?.();
          }
        }}
      />
      {open && suggestions.length > 0 && (
        <ul className="ac__list">
          {suggestions.map((s, i) => (
            <li
              key={s}
              className={`ac__item${i === hi ? ' ac__item--hi' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(s);
              }}
              onMouseEnter={() => setHi(i)}
            >
              {s}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
