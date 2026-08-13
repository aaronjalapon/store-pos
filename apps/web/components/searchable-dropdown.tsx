'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown, Plus, Search } from 'lucide-react';

interface SearchableDropdownProps {
  label: string;
  name: string;
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
}

export function SearchableDropdown({
  label, name, value, options, onChange, placeholder, required = false,
}: SearchableDropdownProps) {
  const inputId = useId();
  const listboxId = `${inputId}-options`;
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [filtering, setFiltering] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const query = value.trim().toLocaleLowerCase();
  const matches = options.filter((option) => !filtering || !query || option.toLocaleLowerCase().includes(query));
  const hasExactMatch = options.some((option) => option.toLocaleLowerCase() === query);
  const canUseCustomValue = Boolean(value.trim()) && !hasExactMatch;
  const optionCount = matches.length + (canUseCustomValue ? 1 : 0);

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, []);

  const choose = (nextValue: string) => {
    onChange(nextValue);
    setFiltering(false);
    setOpen(false);
  };

  return <div className="searchable-dropdown" ref={rootRef}>
    <label htmlFor={inputId}>{label}</label>
    <div className="searchable-dropdown-input">
      <Search aria-hidden="true" />
      <input
        id={inputId}
        name={name}
        value={value}
        required={required}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={open && optionCount ? `${listboxId}-${highlighted}` : undefined}
        placeholder={placeholder}
        autoComplete="off"
        onFocus={(event) => { event.currentTarget.select(); setFiltering(false); setOpen(true); setHighlighted(0); }}
        onChange={(event) => { onChange(event.target.value); setFiltering(true); setOpen(true); setHighlighted(0); }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setOpen(true);
            setHighlighted((current) => Math.min(Math.max(optionCount - 1, 0), current + 1));
          }
          if (event.key === 'ArrowUp') {
            event.preventDefault();
            setOpen(true);
            setHighlighted((current) => Math.max(0, current - 1));
          }
          if (event.key === 'Escape') setOpen(false);
          if (event.key === 'Enter' && open && optionCount) {
            event.preventDefault();
            choose(highlighted < matches.length ? matches[highlighted] : value.trim());
          }
        }}
      />
      <button type="button" aria-label={`Show ${label.toLocaleLowerCase()} options`} onClick={() => { setFiltering(false); setOpen((current) => !current); }}>
        <ChevronDown aria-hidden="true" />
      </button>
    </div>
    {open && <div id={listboxId} className="searchable-dropdown-options" role="listbox" aria-label={`${label} options`}>
      {matches.map((option, index) => <button
        type="button"
        role="option"
        id={`${listboxId}-${index}`}
        aria-selected={option.toLocaleLowerCase() === query}
        className={index === highlighted ? 'highlighted' : ''}
        key={option}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => choose(option)}
      >
        <span>{option}</span>
        {option.toLocaleLowerCase() === query && <Check aria-hidden="true" />}
      </button>)}
      {canUseCustomValue && <button
        type="button"
        role="option"
        id={`${listboxId}-${matches.length}`}
        aria-selected="false"
        className={`custom-option ${highlighted === matches.length ? 'highlighted' : ''}`}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => choose(value.trim())}
      >
        <Plus aria-hidden="true" />
        <span>Use “{value.trim()}”</span>
      </button>}
      {!optionCount && <p>No matching options.</p>}
    </div>}
  </div>;
}
