import { createContext, useContext, useState, useCallback, type ReactNode } from 'react'
import { createElement } from 'react'

export type Env = 'live' | 'test'

function getStoredEnv(): Env {
  if (typeof window === 'undefined') return 'live'
  return (localStorage.getItem('gopaylocal_env') as Env) || 'live'
}

interface EnvContextValue {
  env: Env
  setEnv: (e: Env) => void
}

const EnvContext = createContext<EnvContextValue | null>(null)

export function EnvProvider({ children }: { children: ReactNode }) {
  const [env, setEnvState] = useState<Env>(getStoredEnv)

  const setEnv = useCallback((e: Env) => {
    setEnvState(e)
    localStorage.setItem('gopaylocal_env', e)
  }, [])

  return createElement(EnvContext.Provider, { value: { env, setEnv } }, children)
}

export function useEnv(): EnvContextValue {
  const ctx = useContext(EnvContext)
  if (!ctx) throw new Error('useEnv must be used within EnvProvider')
  return ctx
}
