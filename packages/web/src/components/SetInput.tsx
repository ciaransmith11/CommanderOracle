import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

/**
 * A text input with set name/code type-ahead (like CommanderInput). The user can
 * type a set name OR code; suggestions show "Name (CODE)". The chosen value is
 * the set name — the server resolves name-or-code to the canonical code.
 */
export function SetInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  const [suggestions, setSuggestions] = useState<{ code: string; name: string }[]>([]);
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(-1);
  const boxRef = useRef<HTMLDivElement>(null);
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
        .searchSets(q)
        .then((r) => {
          if (cancelled) return;
          setSuggestions(r.sets);
          setOpen(r.sets.length > 0);
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
    <div className="ac ac--down setpool__input" ref={boxRef}>
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
              choose(suggestions[hi]!.name);
              return;
            }
            if (e.key === 'Escape') {
              setOpen(false);
              return;
            }
          }
        }}
      />
      {open && suggestions.length > 0 && (
        <ul className="ac__list">
          {suggestions.map((s, i) => (
            <li
              key={s.code}
              className={`ac__item${i === hi ? ' ac__item--hi' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(s.name);
              }}
              onMouseEnter={() => setHi(i)}
            >
              {s.name} <span className="ac__code">{s.code}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
