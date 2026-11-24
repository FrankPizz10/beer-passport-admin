import React, { useEffect, useId, useRef, useState } from "react";

// Small contextual help control: a "?" button with an accessible
// name ("Help: <topic>") that reveals a short explanatory popover.
// The popover opens on hover, on keyboard focus, and on click/tap
// (click pins it open, which is what touch users get); Escape
// closes it and returns focus to the button. Tips are always
// supplementary: essential instructions also appear as normal text
// next to the control they explain.
const HelpTip: React.FC<{
  topic: string;
  children: React.ReactNode;
}> = ({ topic, children }) => {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  // Set when Escape programmatically returns focus to the button:
  // that focus event must not immediately reopen the popover.
  const suppressFocusOpenRef = useRef(false);
  const tipId = useId();

  const close = () => {
    setOpen(false);
    setPinned(false);
  };

  // Close when focus leaves the whole tip (button + popover) so a
  // keyboard user tabbing away does not leave a stale popover.
  useEffect(() => {
    if (!open) return;
    const onFocusIn = (event: FocusEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        close();
      }
    };
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        close();
      }
    };
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [open ]);

  return (
    <span
      className="help-tip"
      ref={rootRef}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => {
        if (!pinned) setOpen(false);
      }}
    >
      <button
        type="button"
        ref={buttonRef}
        className="help-tip-button"
        aria-label={`Help: ${topic}`}
        aria-expanded={open}
        aria-describedby={open ? tipId : undefined}
        onFocus={() => {
          if (suppressFocusOpenRef.current) {
            suppressFocusOpenRef.current = false;
            return;
          }
          setOpen(true);
        }}
        onBlur={() => {
          if (!pinned) setOpen(false);
        }}
        onClick={() => {
          if (pinned) {
            close();
          } else {
            setPinned(true);
            setOpen(true);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            close();
            if (document.activeElement !== buttonRef.current) {
              suppressFocusOpenRef.current = true;
              buttonRef.current?.focus();
            }
          }
        }}
      >
        ?
      </button>
      {open && (
        <span className="help-tip-popover" role="note" id={tipId}>
          {children}
        </span>
      )}
    </span>
  );
};

export default HelpTip;
