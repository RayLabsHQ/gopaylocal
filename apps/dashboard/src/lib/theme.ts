import { useCallback, useEffect } from 'react'

export type Theme = 'system' | 'light' | 'dark'

// Dark-only for launch: the light palette isn't designed yet, so the theme is
// pinned and the setter is a no-op. Restore the storage/media-query logic from
// git history when a light theme ships.
export function useTheme() {
  useEffect(() => {
    document.documentElement.classList.add('dark')
  }, [])

  const setTheme = useCallback((_t: Theme) => {}, [])
  return { theme: 'dark' as Theme, setTheme }
}
