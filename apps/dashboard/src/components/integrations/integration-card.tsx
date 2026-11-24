import { providerCanImportProducts, providerHasTestMode } from '@gopaylocal/shared'
import type { Integration, IntegrationEnvironment, IntegrationHealthIssue } from '~/lib/api'
import { Menu, type MenuItem } from '~/components/ui/menu'
import { inSentence, providerLogo, providerMeta } from './providers'
import { btnPrimary, btnSecondary, LogoTile, Status } from './parts'

const ENVIRONMENTS: IntegrationEnvironment[] = ['live', 'test']

const AREA_LABELS: Record<IntegrationHealthIssue['area'], string> = {
  coupon_sync: 'Discount codes',
  webhook_setup: 'Redemption tracking',
  webhook_delivery: 'Redemption tracking',
  credentials: 'API key',
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

export function hasKey(integration: Integration, env: IntegrationEnvironment): boolean {
  return env === 'live' ? integration.hasLiveCredentials : integration.hasTestCredentials
}

/** Anything the merchant should look at: a recorded problem, or an environment whose tracking isn't working. */
export function needsAttention(integration: Integration): boolean {
  if ((integration.health?.length ?? 0) > 0) return true
  return ENVIRONMENTS.some((env) => {
    const status = integration.webhooks?.[env]?.status
    return hasKey(integration, env) && !!status && status !== 'active'
  })
}

export type CardActions = {
  onTest: () => void
  onKey: (env: IntegrationEnvironment) => void
  onWebhook: (env: IntegrationEnvironment) => void
  onImport: () => void
  onDisconnect: () => void
  onCreateCampaign: () => void
}

function IssueBox({
  issue,
  action,
}: {
  issue: IntegrationHealthIssue
  action?: { label: string; onClick: () => void; pending?: boolean }
}) {
  return (
    <div className="flex flex-col gap-2.5 border border-warning-border bg-warning-light px-3.5 py-3">
      <p className="text-[13px] text-text-primary">
        <span className="font-semibold text-warning">{AREA_LABELS[issue.area]}:</span> {issue.message}{' '}
        <span className="text-text-muted">{formatDate(issue.at)}</span>
      </p>
      {action && (
        <div>
          <button
            type="button"
            onClick={action.onClick}
            disabled={action.pending}
            className="inline-flex h-9 items-center border border-warning px-3.5 text-[13px] font-medium text-warning transition-colors hover:bg-warning/10 disabled:opacity-50"
          >
            {action.pending ? 'Working…' : action.label}
          </button>
        </div>
      )}
    </div>
  )
}

function EnvCell({
  integration,
  env,
  canManage,
  webhookPending,
  actions,
}: {
  integration: Integration
  env: IntegrationEnvironment
  canManage: boolean
  webhookPending: boolean
  actions: CardActions
}) {
  const meta = providerMeta(integration.provider)
  const heading = (
    <h4 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted">{env === 'live' ? 'Live' : 'Test'}</h4>
  )

  if (env === 'test' && !providerHasTestMode(integration.provider)) {
    return (
      <div className="flex flex-col gap-2.5 bg-panel px-5 py-4 sm:px-6">
        {heading}
        <p className="text-[13px] text-text-muted">
          {meta.name} has no test mode: its {inSentence(meta.keyLabel)} always acts on your real account, so it connects
          in Live only.
        </p>
      </div>
    )
  }

  const saved = hasKey(integration, env)
  const status = integration.webhooks?.[env]?.status
  const issues = (integration.health ?? []).filter((h) => h.environment === env)
  const trackingIssue = issues.some((h) => h.area === 'webhook_setup' || h.area === 'webhook_delivery')
  const webhookAction = canManage
    ? {
        label: status === 'missing' ? 'Set up tracking' : 'Re-create webhook',
        onClick: () => actions.onWebhook(env),
        pending: webhookPending,
      }
    : undefined

  return (
    <div className="flex flex-col gap-2.5 bg-panel px-5 py-4 sm:px-6">
      {heading}
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="text-text-secondary">{meta.keyLabel}</span>
        {saved ? (
          <Status tone="ok">Saved</Status>
        ) : canManage ? (
          <button
            type="button"
            onClick={() => actions.onKey(env)}
            className="text-[13px] font-medium text-brand-text underline underline-offset-2 hover:no-underline"
          >
            Add {env} key
          </button>
        ) : (
          <Status tone="off">Not added</Status>
        )}
      </div>
      {saved && status && (
        <div className="flex items-center justify-between gap-3 text-sm">
          <span className="text-text-secondary">Redemption tracking</span>
          {status === 'active' ? (
            <Status tone="ok">Active</Status>
          ) : (
            <Status tone="warn">{status === 'missing' ? 'Not set up' : 'Needs attention'}</Status>
          )}
        </div>
      )}
      {issues.map((issue) => (
        <IssueBox
          key={issue.area}
          issue={issue}
          action={
            !canManage
              ? undefined
              : issue.area === 'webhook_setup' || issue.area === 'webhook_delivery'
                ? webhookAction
                : issue.area === 'credentials'
                  ? { label: `Replace ${env} key`, onClick: () => actions.onKey(env) }
                  : undefined
          }
        />
      ))}
      {saved && status && status !== 'active' && !trackingIssue && webhookAction && (
        <div>
          <button type="button" onClick={webhookAction.onClick} disabled={webhookPending} className={btnSecondary}>
            {webhookPending ? 'Working…' : webhookAction.label}
          </button>
        </div>
      )}
    </div>
  )
}

export function IntegrationCard({
  integration,
  env,
  usedBy,
  productsInEnv,
  canManage,
  canImport,
  testing,
  webhookPendingEnv,
  actions,
}: {
  integration: Integration
  /** The sidebar's Live/Test: importing works in this environment. */
  env: IntegrationEnvironment
  /** Campaigns using this integration; null while unknown. */
  usedBy: number | null
  /** Products in `env`; null while unknown. */
  productsInEnv: number | null
  canManage: boolean
  canImport: boolean
  testing: boolean
  webhookPendingEnv: IntegrationEnvironment | null
  actions: CardActions
}) {
  const meta = providerMeta(integration.provider)
  const attention = needsAttention(integration)
  const withTestMode = providerHasTestMode(integration.provider)
  const importable = canImport && providerCanImportProducts(integration.provider) && hasKey(integration, env)
  const anyKey = integration.hasLiveCredentials || integration.hasTestCredentials
  const generalIssues = (integration.health ?? []).filter((h) => !h.environment)

  const menu: MenuItem[] = [
    { label: integration.hasLiveCredentials ? 'Replace live key' : 'Add live key', onSelect: () => actions.onKey('live') },
    ...(withTestMode
      ? [{ label: integration.hasTestCredentials ? 'Replace test key' : 'Add test key', onSelect: () => actions.onKey('test') }]
      : []),
    ...(importable ? [{ label: `Import ${env} products`, onSelect: actions.onImport }] : []),
    ...ENVIRONMENTS.filter((e) => hasKey(integration, e)).map((e) => ({
      label: `Re-create ${e} webhook`,
      onSelect: () => actions.onWebhook(e),
      disabled: webhookPendingEnv === e,
    })),
    { kind: 'separator' as const },
    { label: 'Disconnect…', onSelect: actions.onDisconnect, danger: true },
  ]

  const next =
    importable && productsInEnv === 0
      ? {
          text: `bring your ${meta.name} products into GoPayLocal so campaigns can price them.`,
          label: 'Import products',
          onClick: actions.onImport,
        }
      : canManage && usedBy === 0
        ? {
            text: `create a campaign that uses ${meta.name}. Its codes are created in ${meta.name} for you.`,
            label: 'Create a campaign',
            onClick: actions.onCreateCampaign,
          }
        : null

  return (
    <article aria-labelledby={`integration-${integration.id}`} className="border border-border bg-panel">
      <header className="flex flex-wrap items-center gap-4 border-b border-border px-5 py-5 sm:px-6">
        <LogoTile src={providerLogo(integration.provider)} size="lg" />
        <div className="flex min-w-0 flex-[1_1_220px] flex-col gap-0.5">
          <div className="flex flex-wrap items-center gap-3">
            <h3 id={`integration-${integration.id}`} className="font-display text-lg font-semibold text-text-primary">
              {meta.name}
            </h3>
            <span className="text-xs font-medium">
              <Status tone={attention ? 'warn' : 'ok'} colorText>
                {attention ? 'Needs attention' : 'Working'}
              </Status>
            </span>
          </div>
          <p className="text-[13px] text-text-muted">
            Connected {formatDate(integration.createdAt)}
            {usedBy !== null && ` · Used by ${usedBy} campaign${usedBy === 1 ? '' : 's'}`}
          </p>
        </div>
        {canManage && (
          <div className="flex gap-2">
            <button type="button" onClick={actions.onTest} disabled={testing || !anyKey} className={btnSecondary}>
              {testing ? 'Testing…' : 'Test connection'}
            </button>
            <Menu label="Manage" aria-label={`Manage ${meta.name}`} items={menu} />
          </div>
        )}
      </header>

      <div className="grid gap-px bg-border sm:grid-cols-2">
        {ENVIRONMENTS.map((e) => (
          <EnvCell
            key={e}
            integration={integration}
            env={e}
            canManage={canManage}
            webhookPending={webhookPendingEnv === e}
            actions={actions}
          />
        ))}
      </div>

      {generalIssues.length > 0 && (
        <div className="flex flex-col gap-2 border-t border-border px-5 py-4 sm:px-6">
          {generalIssues.map((issue) => (
            <IssueBox key={issue.area} issue={issue} />
          ))}
        </div>
      )}

      {next && (
        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-panel-inset px-5 py-3.5 sm:px-6">
          <p className="text-[13px] text-text-secondary">
            <span className="font-medium text-text-primary">Next:</span> {next.text}
          </p>
          <button type="button" onClick={next.onClick} className={btnPrimary}>
            {next.label}
          </button>
        </footer>
      )}
    </article>
  )
}
