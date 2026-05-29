import { useState } from 'react';

export function Section({ title, defaultOpen = true, action, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={`section${open ? ' is-open' : ''}`}>
      <header className="section__head">
        <button
          type="button"
          className="section__toggle"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          <svg
            className="section__chevron"
            width="10"
            height="10"
            viewBox="0 0 10 10"
            fill="none"
            aria-hidden
          >
            <path d="M3 1.5L7 5L3 8.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span>{title}</span>
        </button>
        {action ?? null}
      </header>
      {open ? <div className="section__body">{children}</div> : null}
    </section>
  );
}
