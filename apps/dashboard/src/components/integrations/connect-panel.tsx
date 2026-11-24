import { useId, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { IntegrationProvider } from '@gopaylocal/shared'
import { PROVIDER_KEY_ACCESS, providerCanImportProducts } from '@gopaylocal/shared'
import {
  api,
  ApiError,
  type IntegrationEnvironment,
  type IntegrationWithSetup,
  type WebhookSetupResult,
} from '~/lib/api'
import { SidePanel, SidePanelBody, SidePanelFooter } from '~/components/ui/side-panel'
import { inSentence, providerLogo, providerMeta, withArticle } from './providers'
import { btnPrimary, btnSecondary, EnvBadge, ExternalIcon, LockIcon, LogoTile, ResultMark } from './parts'
import { ErrorText, ToneIcon } from '~/components/ui/status'

export type ConnectTarget = {
  provider: IntegrationProvider
  environment: IntegrationEnvironment
  /** connect: not connected yet. add: connected, but not in this environment. replace: a new key for a saved one. */
  mode: 'connect' | 'add' | 'replace'
  /** Opened from the "Add a platform" list, where the sidebar's Live/Test picks the environment. */
  fromList: boolean
  accountId: string
}

/** "Products: Read" → resource and level; scope names like discounts:read stay whole. */
function splitPermission(name: string): { resource: string; level?: 'Read' | 'Write' } {
  const m = /^(.+): (Read|Write)$/.exec(name)
  return m ? { resource: m[1]!, level: m[2] as 'Read' | 'Write' } : { resource: name }
}

function Step({ n, title, area, children }: { n: number; title: string; area: string; children: React.ReactNode }) {
  return (
    <section className={`flex gap-3.5 ${area}`}>
      <span
        aria-hidden="true"
        className="flex h-[26px] w-[26px] flex-none items-center justify-center border border-border-strong text-[13px] font-semibold text-text-primary"
      >
        {n}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <h3 className="text-[15px] font-semibold text-text-primary">{title}</h3>
        {children}
      </div>
    </section>
  )
}

export function ConnectPanel({
  teamId,
  target,
  canImport,
  onClose,
  onImport,
  onCreateCampaign,
}: {
  teamId: string
  target: ConnectTarget
  canImport: boolean
  onClose: () => void
  onImport: (integrationId: string, environment: IntegrationEnvironment) => void
  onCreateCampaign: () => void
}) {
  const queryClient = useQueryClient()
  const titleId = useId()
  const keyId = useId()
  const accountIdId = useId()
  const meta = providerMeta(target.provider)
  const access = PROVIDER_KEY_ACCESS[target.provider]
  const env = target.environment

  const [apiKey, setApiKey] = useState('')
  const [accountId, setAccountId] = useState(target.accountId)
  const [connected, setConnected] = useState<IntegrationWithSetup | null>(null)
  const [tracking, setTracking] = useState<WebhookSetupResult | null>(null)

  const connect = useMutation({
    mutationFn: () =>
      api.integrations.connect(teamId, target.provider, {
        accessToken: apiKey.trim(),
        providerAccountId: accountId.trim() || undefined,
        environment: env,
      }),
    onSuccess: (data) => {
      setApiKey('')
      setConnected(data)
      setTracking(data.webhookSetup)
      queryClient.invalidateQueries({ queryKey: ['integrations', teamId] })
    },
  })

  const retryTracking = useMutation({
    mutationFn: (integrationId: string) => api.integrations.setupWebhook(teamId, integrationId, env),
    onSuccess: (data) => {
      setTracking(data.webhookSetup)
      queryClient.invalidateQueries({ queryKey: ['integrations', teamId] })
    },
  })

  const rejected = connect.error instanceof ApiError && connect.error.data?.code === 'key_rejected'
  const title =
    target.mode === 'replace'
      ? `Replace ${meta.name}'s ${env} key`
      : target.mode === 'add'
        ? `Add ${meta.name}'s ${env} key`
        : `Connect ${meta.name}`
  const otherEnv = env === 'live' ? 'test' : 'live'
  const showImport = canImport && providerCanImportProducts(target.provider)

  return (
    <SidePanel open onClose={onClose} labelledBy={titleId} wide>
      <header className="flex flex-col gap-2 border-b border-border px-5 py-4 sm:px-6">
        <div className="flex items-center gap-3">
          <LogoTile src={providerLogo(target.provider)} size="sm" />
          <h2 id={titleId} className="min-w-0 flex-1 font-display text-xl font-semibold text-text-primary">
            {title}
          </h2>
          <EnvBadge env={env} />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex h-10 w-10 items-center justify-center text-text-secondary transition-colors hover:text-text-primary"
          >
            <svg aria-hidden="true" className="h-[18px] w-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </div>
        {!connected && (
          <p className="text-[13px] text-text-secondary">
            {env === 'live'
              ? `Saved for live campaigns: codes are created in your real ${meta.name} account.`
              : `Saved for test campaigns, which use ${meta.name}'s test mode.`}
            {target.fromList && target.mode === 'connect' && (
              <> For a {otherEnv} key, switch to {otherEnv === 'live' ? 'Live' : 'Test'} in the sidebar first.</>
            )}
            {target.mode === 'replace' && ' The saved key stays in place unless the new one works.'}
          </p>
        )}
      </header>

      {!connected ? (
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault()
            if (apiKey.trim() && !connect.isPending) connect.mutate()
          }}
        >
          <SidePanelBody>
            {/* One column on phones: the permissions follow step 2. Two from lg:
                the steps on the left, the permissions beside them. */}
            <div className="grid gap-7 [grid-template-areas:'create'_'grant'_'perms'_'paste'] lg:grid-cols-2 lg:grid-rows-[auto_auto_1fr] lg:gap-x-8 lg:[grid-template-areas:'create_perms'_'grant_perms'_'paste_perms']">
              <Step n={1} title={`Create ${withArticle(meta.keyLabel)} in ${meta.name}`} area="[grid-area:create]">
                <p className="text-[13px] leading-relaxed text-text-secondary">{access.key}</p>
                <div>
                  <a
                    href={meta.docsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex h-9 items-center gap-2 border border-border-strong px-3 text-[13px] font-medium text-text-primary transition-colors hover:bg-surface"
                  >
                    {meta.name}'s instructions
                    <ExternalIcon />
                    <span className="sr-only">(opens in a new tab)</span>
                  </a>
                </div>
              </Step>

              <Step
                n={2}
                title={meta.narrowable ? 'Give it only these permissions' : 'What GoPayLocal uses it for'}
                area="[grid-area:grant]"
              >
                <p className="text-[13px] leading-relaxed text-text-secondary">
                  {access.note ?? 'Leave everything else off.'}
                </p>
              </Step>

              <section aria-labelledby={`${titleId}-perms`} className="flex min-w-0 flex-col gap-2.5 pl-10 [grid-area:perms] lg:pl-0">
                <h3 id={`${titleId}-perms`} className="text-xs font-semibold uppercase tracking-[0.08em] text-text-secondary">
                  {meta.narrowable ? 'Permissions the key needs' : 'What it is used for'}
                </h3>
                <ul className="border border-border">
                  {access.permissions.map((permission) => {
                    const { resource, level } = splitPermission(permission.name)
                    return (
                      <li key={permission.name} className="flex flex-col gap-0.5 border-b border-border px-3 py-2.5 last:border-b-0">
                        <div className="flex items-center justify-between gap-3">
                          <code className="font-mono text-[12.5px] text-text-primary">{resource}</code>
                          {level && (
                            <span
                              className={`text-[11px] font-semibold uppercase tracking-[0.06em] ${level === 'Write' ? 'text-text-primary' : 'text-text-secondary'}`}
                            >
                              {level}
                            </span>
                          )}
                        </div>
                        <span className="text-[12.5px] leading-snug text-text-muted">{permission.usedFor}</span>
                      </li>
                    )
                  })}
                </ul>
              </section>

              <Step n={3} title={`Paste the ${inSentence(meta.keyLabel)}`} area="[grid-area:paste]">
                <label htmlFor={keyId} className="text-[13px] text-text-secondary">
                  {meta.keyLabel}
                </label>
                <input
                  id={keyId}
                  type="password"
                  required
                  autoComplete="off"
                  spellCheck={false}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={meta.placeholder[env]}
                  aria-describedby={meta.keyHelp ? `${keyId}-help` : undefined}
                  aria-invalid={rejected || undefined}
                  className="h-11 w-full border border-control bg-bg px-3 font-mono text-sm text-text-primary placeholder:text-text-muted focus:border-brand focus:outline-none"
                />
                {meta.keyHelp && (
                  <p id={`${keyId}-help`} className="text-xs text-text-secondary">{meta.keyHelp}</p>
                )}
                {meta.accountId && (
                  <>
                    <label htmlFor={accountIdId} className="mt-2 text-[13px] text-text-secondary">
                      {meta.accountId.label}
                    </label>
                    <input
                      id={accountIdId}
                      type="text"
                      required
                      autoComplete="off"
                      spellCheck={false}
                      value={accountId}
                      onChange={(e) => setAccountId(e.target.value)}
                      placeholder={meta.accountId.placeholder}
                      aria-describedby={`${accountIdId}-help`}
                      className="h-11 w-full border border-control bg-bg px-3 text-sm text-text-primary placeholder:text-text-muted focus:border-brand focus:outline-none"
                    />
                    <p id={`${accountIdId}-help`} className="text-xs text-text-secondary">{meta.accountId.help}</p>
                  </>
                )}
                <p className="flex gap-2 text-[12.5px] text-text-muted">
                  <LockIcon className="mt-0.5 h-3.5 w-3.5 flex-none" />
                  <span>Encrypted before it's stored. Nobody can see it again, including you.</span>
                </p>
              </Step>
            </div>

            {connect.error && (
              <div role="alert" className="mt-7 flex gap-3 border border-error-border bg-error-light px-4 py-3 text-[13px] text-text-primary">
                <ToneIcon tone="error" className="mt-[3px] h-3.5 w-3.5" />
                <div>
                  <p className="font-semibold text-error">{rejected ? `${meta.name} didn't accept the key` : "Couldn't connect"}</p>
                  <p className="mt-1 text-text-secondary">{connect.error.message}</p>
                  {rejected && (
                    <p className="mt-1 text-text-secondary">
                      Check that it is a {env} key and has the permissions listed. Nothing was saved.
                    </p>
                  )}
                </div>
              </div>
            )}
          </SidePanelBody>
          <SidePanelFooter>
            <button type="button" onClick={onClose} className={btnSecondary}>
              Cancel
            </button>
            <button type="submit" disabled={!apiKey.trim() || connect.isPending} className={btnPrimary}>
              {connect.isPending ? 'Checking the key…' : target.mode === 'replace' ? 'Verify and replace' : 'Verify and connect'}
            </button>
          </SidePanelFooter>
        </form>
      ) : (
        <>
          <SidePanelBody>
            <div className={`grid gap-8 ${target.mode !== 'replace' ? 'lg:grid-cols-2' : ''}`}>
              <div className="flex flex-col gap-4">
                <h3 className="font-display text-xl font-semibold text-text-primary">
                  {tracking?.status === 'failed'
                    ? `${meta.name} is connected, with one problem`
                    : target.mode === 'replace'
                      ? 'The new key is in use'
                      : `${meta.name} is connected`}
                </h3>
                <ul className="border border-border">
                  <li className="flex gap-3 border-b border-border px-4 py-3.5 last:border-b-0">
                    <ResultMark tone="ok" />
                    <div>
                      <p className="font-semibold text-text-primary">Key accepted</p>
                      <p className="text-[13px] text-text-muted">
                        {meta.name} accepted it{target.mode === 'replace' ? ', and it replaced the old one' : ''}.
                      </p>
                    </div>
                  </li>
                  {tracking?.status === 'active' && (
                    <li className="flex gap-3 px-4 py-3.5">
                      <ResultMark tone="ok" />
                      <div>
                        <p className="font-semibold text-text-primary">Redemption tracking set up</p>
                        <p className="text-[13px] text-text-muted">
                          {meta.name} will tell GoPayLocal each time a customer uses a code.
                        </p>
                      </div>
                    </li>
                  )}
                  {tracking?.status === 'failed' && (
                    <li className="flex gap-3 bg-warning-light px-4 py-3.5">
                      <ResultMark tone="warn" />
                      <div className="flex flex-col gap-2.5">
                        <div>
                          <p className="font-semibold text-text-primary">Redemption tracking not set up</p>
                          <p className="text-[13px] text-text-secondary">
                            {tracking.error ? `${tracking.error} ` : ''}Codes still work, but redemptions aren't
                            recorded until this is fixed.
                          </p>
                        </div>
                        <div>
                          <button
                            type="button"
                            onClick={() => retryTracking.mutate(connected.id)}
                            disabled={retryTracking.isPending}
                            className="inline-flex h-9 items-center border border-warning px-3.5 text-[13px] font-medium text-warning transition-colors hover:bg-warning/10 disabled:opacity-50"
                          >
                            {retryTracking.isPending ? 'Trying again…' : 'Try again'}
                          </button>
                          {retryTracking.error && (
                            <ErrorText className="mt-2">{retryTracking.error.message}</ErrorText>
                          )}
                        </div>
                      </div>
                    </li>
                  )}
                  {tracking?.status === 'unsupported' && (
                    <li className="flex gap-3 px-4 py-3.5">
                      <ResultMark tone="info" />
                      <p className="text-[13px] text-text-secondary">
                        {meta.name} can't report redemptions to GoPayLocal automatically.
                      </p>
                    </li>
                  )}
                </ul>
              </div>

              {target.mode !== 'replace' && (
                <div className="flex flex-col gap-2.5 self-start border border-border bg-panel-inset p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.08em] text-text-muted">Next</p>
                  <p className="text-sm text-text-primary">
                    {showImport
                      ? `Import your ${meta.name} products so campaigns can price them.`
                      : `Create a campaign that uses ${meta.name}. GoPayLocal creates its codes in ${meta.name} for you.`}
                  </p>
                  <div>
                    <button
                      type="button"
                      onClick={() => (showImport ? onImport(connected.id, env) : onCreateCampaign())}
                      className={btnPrimary}
                    >
                      {showImport ? 'Import products' : 'Create a campaign'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </SidePanelBody>
          <SidePanelFooter>
            <button type="button" onClick={onClose} className={btnSecondary}>
              Done
            </button>
          </SidePanelFooter>
        </>
      )}
    </SidePanel>
  )
}
