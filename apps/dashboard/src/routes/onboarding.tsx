import { useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { workspaceSlug } from '@gopaylocal/shared'
import { useSession, organization } from '~/lib/auth'
import { ErrorText } from '~/components/ui/status'

export const Route = createFileRoute('/onboarding')({
  component: OnboardingPage,
})

type Step = 'workspace' | 'invite' | 'done'

function OnboardingPage() {
  const navigate = useNavigate()
  const { data: session, isPending } = useSession()
  const [step, setStep] = useState<Step>('workspace')
  const [orgId, setOrgId] = useState<string | null>(null)

  // Workspace step state
  const [orgName, setOrgName] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Invite step state
  const [emails, setEmails] = useState<string[]>([''])
  const [inviting, setInviting] = useState(false)
  const [inviteError, setInviteError] = useState<string | null>(null)

  if (isPending) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-border border-t-brand" />
      </div>
    )
  }

  if (!session) {
    navigate({ to: '/login' })
    return null
  }

  const handleCreateWorkspace = async () => {
    const name = orgName.trim()
    if (!name) return
    setError(null)
    setCreating(true)
    try {
      // Never empty: a name with no ASCII letters or digits gets a random slug.
      const slug = workspaceSlug(name)
      const { data, error: apiError } = await organization.create({
        name,
        slug,
      })
      if (apiError) {
        setError(apiError.message || 'Failed to create workspace')
        return
      }
      if (data) {
        setOrgId(data.id)
        await organization.setActive({ organizationId: data.id })
        setStep('invite')
      }
    } catch (e: any) {
      setError(e?.message || 'Something went wrong')
    } finally {
      setCreating(false)
    }
  }

  const handleInvite = async () => {
    if (!orgId) return
    const validEmails = emails.map((e) => e.trim()).filter(Boolean)
    if (validEmails.length === 0) {
      setStep('done')
      return
    }
    setInviteError(null)
    setInviting(true)
    try {
      for (const email of validEmails) {
        await organization.inviteMember({
          email,
          role: 'member',
          organizationId: orgId,
        })
      }
      setStep('done')
    } catch (e: any) {
      setInviteError(e?.message || 'Failed to send invites')
    } finally {
      setInviting(false)
    }
  }

  const handleGoToDashboard = () => {
    // Hard navigate to force a fresh session fetch with the new activeOrganizationId
    window.location.href = '/dashboard'
  }

  const addEmailField = () => {
    setEmails([...emails, ''])
  }

  const updateEmail = (index: number, value: string) => {
    const updated = [...emails]
    updated[index] = value
    setEmails(updated)
  }

  const removeEmail = (index: number) => {
    if (emails.length <= 1) return
    setEmails(emails.filter((_, i) => i !== index))
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-4 font-body">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="mb-10 text-center">
          <div className="mx-auto flex h-8 w-8 items-center justify-center bg-brand">
            <svg className="h-4.5 w-4.5 text-white" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9.004 9.004 0 0 0 8.716-6.747M12 21a9.004 9.004 0 0 1-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 0 1 7.843 4.582M12 3a8.997 8.997 0 0 0-7.843 4.582m15.686 0A11.953 11.953 0 0 1 12 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0 1 21 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0 1 12 16.5a17.92 17.92 0 0 1-8.716-2.247m0 0A8.966 8.966 0 0 1 3 12c0-1.264.26-2.466.732-3.558" />
            </svg>
          </div>
        </div>

        {/* Progress */}
        <div className="mb-8 flex items-center justify-center gap-2">
          {(['workspace', 'invite', 'done'] as const).map((s, i) => (
            <div key={s} className="flex items-center gap-2">
              <div
                className={`h-2 w-2 rounded-full ${
                  s === step
                    ? 'bg-brand'
                    : (['workspace', 'invite', 'done'].indexOf(step) > i
                        ? 'bg-brand/40'
                        : 'bg-border')
                }`}
              />
              {i < 2 && (
                <div className={`h-px w-8 ${
                  ['workspace', 'invite', 'done'].indexOf(step) > i ? 'bg-brand/40' : 'bg-border'
                }`} />
              )}
            </div>
          ))}
        </div>

        {/* Step 1: Create Workspace */}
        {step === 'workspace' && (
          <div className="border border-border bg-surface p-8">
            <h1 className="font-display text-2xl font-semibold text-text-primary">
              Create your workspace
            </h1>
            <p className="mt-2 text-base text-text-secondary">
              This is where you'll manage your PPP discounts, products, and campaigns.
            </p>

            <div className="mt-6">
              <label htmlFor="org-name" className="block text-sm font-medium text-text-primary">
                Workspace name
              </label>
              <input
                id="org-name"
                type="text"
                value={orgName}
                onChange={(e) => setOrgName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCreateWorkspace()}
                placeholder="e.g. Acme Inc"
                autoFocus
                className="mt-1.5 w-full border border-control bg-bg px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-brand focus:outline-none"
              />
            </div>

            {error && (
              <ErrorText className="mt-3">{error}</ErrorText>
            )}

            <button
              type="button"
              onClick={handleCreateWorkspace}
              disabled={!orgName.trim() || creating}
              className="mt-6 w-full bg-brand px-4 py-2.5 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {creating ? 'Creating...' : 'Continue'}
            </button>
          </div>
        )}

        {/* Step 2: Invite Team */}
        {step === 'invite' && (
          <div className="border border-border bg-surface p-8">
            <h1 className="font-display text-2xl font-semibold text-text-primary">
              Invite your team
            </h1>
            <p className="mt-2 text-base text-text-secondary">
              Add team members to collaborate on your PPP campaigns. You can always do this later.
            </p>

            <div className="mt-6 space-y-3">
              {emails.map((email, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => updateEmail(i, e.target.value)}
                    placeholder="teammate@company.com"
                    className="flex-1 border border-control bg-bg px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-brand focus:outline-none"
                  />
                  {emails.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeEmail(i)}
                      className="px-2 py-2 text-text-secondary hover:text-text-primary"
                    >
                      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                      </svg>
                    </button>
                  )}
                </div>
              ))}
            </div>

            <button
              type="button"
              onClick={addEmailField}
              className="mt-3 text-[13px] font-medium text-brand-text hover:underline"
            >
              + Add another
            </button>

            {inviteError && (
              <ErrorText className="mt-3">{inviteError}</ErrorText>
            )}

            <div className="mt-6 flex gap-3">
              <button
                type="button"
                onClick={() => setStep('done')}
                className="flex-1 border border-border px-4 py-2.5 text-sm font-medium text-text-secondary transition-colors hover:text-text-primary"
              >
                Skip
              </button>
              <button
                type="button"
                onClick={handleInvite}
                disabled={inviting}
                className="flex-1 bg-brand px-4 py-2.5 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {inviting ? 'Sending...' : 'Send invites'}
              </button>
            </div>
          </div>
        )}

        {/* Step 3: Done */}
        {step === 'done' && (
          <div className="border border-border bg-surface p-8 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center bg-brand/10">
              <svg className="h-6 w-6 text-brand-text" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
              </svg>
            </div>
            <h1 className="mt-4 font-display text-2xl font-semibold text-text-primary">
              You're all set
            </h1>
            <p className="mt-2 text-base text-text-secondary">
              Your workspace is ready. Start by adding your first product.
            </p>
            <button
              type="button"
              onClick={handleGoToDashboard}
              className="mt-6 w-full bg-brand px-4 py-2.5 text-sm font-medium text-white transition-opacity hover:opacity-90"
            >
              Go to dashboard
            </button>
          </div>
        )}

        {/* Step indicator text */}
        <p className="mt-4 text-center text-[13px] text-text-secondary">
          {step === 'workspace' && 'Step 1 of 3'}
          {step === 'invite' && 'Step 2 of 3'}
          {step === 'done' && 'Step 3 of 3'}
        </p>
      </div>
    </div>
  )
}
