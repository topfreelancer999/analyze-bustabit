import { useCallback, useState } from 'react';

/**
 * A preference kept in localStorage so a reload does not reset the view.
 * Storage can throw or be empty, so every access is guarded.
 */
export function usePref<T extends string>(key: string, fallback: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      return (localStorage.getItem(key) as T | null) ?? fallback;
    } catch {
      return fallback;
    }
  });

  const update = useCallback(
    (next: T) => {
      setValue(next);
      try {
        localStorage.setItem(key, next);
      } catch {
        // A private window or blocked storage: the choice just will not persist.
      }
    },
    [key],
  );

  return [value, update];
}
