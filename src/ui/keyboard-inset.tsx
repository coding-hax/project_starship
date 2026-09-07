'use client';

import { useEffect } from 'react';

// Below this, a reported occlusion is iOS overscroll/bounce noise on
// `visualViewport`, not a keyboard (#1097).
const MIN_KEYBOARD_INSET_PX = 150;

function isEditableElement(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLElement && el.isContentEditable) return true;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';
}

/**
 * Keeps `--keyboard-inset` on <html> in sync with the height the on-screen keyboard
 * covers, so bottom-anchored UI (FAB, sheet, toast) can lift above it.
 *
 * Why not just CSS: iOS Safari does not shrink the layout viewport for the keyboard
 * and ignores the `interactive-widget` viewport hint, so `dvh`/`vh` stay put and the
 * input slides behind the keyboard. `window.visualViewport` is the only signal that
 * moves on every platform — its `height` excludes the keyboard, so the difference to
 * `innerHeight` (minus any in-viewport scroll) is what the keyboard covers.
 *
 * Two guards keep that signal from firing without a keyboard (#1097): iOS reports a
 * transient `offsetTop`/shrunk `height` while overscrolling at the end of a scrollable
 * page, with no `input`/`textarea`/`select`/`[contenteditable]` focused — so the inset
 * only ever goes non-zero while such an element holds focus. And even while focused, a
 * reported occlusion below `MIN_KEYBOARD_INSET_PX` is bounce noise, not a keyboard.
 *
 * Renders nothing. Cleans the property up on unmount so nothing leaks a stale inset.
 */
export function KeyboardInset() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    const root = document.documentElement;
    const update = () => {
      if (!isEditableElement(document.activeElement)) {
        root.style.setProperty('--keyboard-inset', '0px');
        return;
      }
      const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      root.style.setProperty(
        '--keyboard-inset',
        `${inset >= MIN_KEYBOARD_INSET_PX ? Math.round(inset) : 0}px`,
      );
    };

    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    document.addEventListener('focusin', update);
    document.addEventListener('focusout', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      document.removeEventListener('focusin', update);
      document.removeEventListener('focusout', update);
      root.style.removeProperty('--keyboard-inset');
    };
  }, []);

  return null;
}
