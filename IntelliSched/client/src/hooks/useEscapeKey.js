import { useEffect } from 'react';

/**
 * Calls onEscape when the Escape key is pressed while `isActive` is true.
 *
 * - `disabled` suppresses the handler (e.g. while a save request is in flight).
 * - A key event a child control already consumed (event.defaultPrevented) is ignored, so a
 *   popover or multi-select that closes itself on Escape does not also close the modal.
 */
export default function useEscapeKey(isActive, onEscape, disabled = false) {
  useEffect(() => {
    if (!isActive) return undefined;

    const handleKeyDown = (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented || disabled) return;
      onEscape();
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isActive, onEscape, disabled]);
}
