import { GitBranch } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'

import { ShuttleMark } from '@/components/shuttle-mark'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { authClient } from '@/lib/auth-client'
import { cn } from '@/lib/cn'
import { fetchSignInProviders, type SignInProviders } from '@/lib/tenant'

type Mode = 'sign-in' | 'sign-up'

/** Shown instead of the app until the browser is signed in. */
export function SignInScreen({
  invited,
  onSignedIn,
}: {
  /** True when the page was opened from an invitation link. */
  invited: boolean
  onSignedIn: () => void
}) {
  const [mode, setMode] = useState<Mode>(invited ? 'sign-up' : 'sign-in')
  const [providers, setProviders] = useState<SignInProviders | null>(null)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [signUpCode, setSignUpCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void fetchSignInProviders().then(setProviders)
  }, [])

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)

    const result =
      mode === 'sign-up'
        ? await authClient.signUp.email(
            { name: name.trim(), email: email.trim(), password },
            // Where the deployment asks for one. See the worker's `auth/signup-code.ts`.
            { headers: { 'x-shuttle-signup-code': signUpCode.trim() } },
          )
        : await authClient.signIn.email({ email: email.trim(), password })

    setBusy(false)

    if (result.error) {
      setError(result.error.message ?? 'That did not work. Check your details and try again.')
      return
    }

    onSignedIn()
  }

  async function withGithub() {
    setError(null)

    // Come back to this same page, so an invitation link is still there to accept.
    const result = await authClient.signIn.social({
      provider: 'github',
      callbackURL: window.location.href,
    })

    if (result.error) {
      setError(result.error.message ?? 'GitHub sign-in could not start.')
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center px-6 py-12">
      <div className="stagger flex w-full max-w-sm flex-col gap-6">
        <div className="flex flex-col gap-3">
          <span className="bg-brand/15 text-foreground ring-brand/25 flex size-9 items-center justify-center rounded-lg ring-1 ring-inset">
            <ShuttleMark className="size-5" />
          </span>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">
              {mode === 'sign-up' ? 'Create your Shuttle account' : 'Sign in to Shuttle'}
            </h1>
            {invited ? (
              <p className="text-muted-foreground mt-1.5 text-[13px] leading-relaxed text-pretty">
                You were invited to an organization. Use the email address the invitation was sent
                to and you will join it after you sign in.
              </p>
            ) : null}
          </div>
        </div>

        {providers?.github ? (
          <>
            <Button variant="outline" size="lg" onClick={() => void withGithub()}>
              <GitBranch />
              Continue with GitHub
            </Button>
            <div className="text-muted-foreground flex items-center gap-3 text-[11px]">
              <span className="bg-border h-px flex-1" />
              or
              <span className="bg-border h-px flex-1" />
            </div>
          </>
        ) : null}

        <form className="flex flex-col gap-3" onSubmit={(event) => void submit(event)}>
          {mode === 'sign-up' ? (
            <Field label="Name">
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                autoComplete="name"
                required
                autoFocus
              />
            </Field>
          ) : null}
          <Field label="Email">
            <Input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
              required
              autoFocus={mode === 'sign-in'}
            />
          </Field>
          <Field label="Password">
            <Input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={mode === 'sign-up' ? 'new-password' : 'current-password'}
              minLength={8}
              required
            />
          </Field>
          {mode === 'sign-up' && providers?.signUpCode ? (
            <Field label="Sign-up code">
              <Input
                value={signUpCode}
                onChange={(event) => setSignUpCode(event.target.value)}
                autoComplete="off"
                required
              />
            </Field>
          ) : null}

          {error ? (
            <p role="alert" className="text-destructive text-[12.5px] leading-relaxed">
              {error}
            </p>
          ) : null}

          <Button type="submit" variant="brand" size="lg" disabled={busy} className="mt-1">
            {mode === 'sign-up' ? 'Create account' : 'Sign in'}
          </Button>
        </form>

        <p className="text-muted-foreground text-[12.5px]">
          {mode === 'sign-up' ? 'Already have an account?' : 'New to Shuttle?'}{' '}
          <button
            type="button"
            className={cn(
              'text-foreground rounded-sm font-medium underline-offset-4 outline-none hover:underline',
              'focus-visible:ring-ring/50 focus-visible:ring-2',
            )}
            onClick={() => {
              setMode(mode === 'sign-up' ? 'sign-in' : 'sign-up')
              setError(null)
            }}
          >
            {mode === 'sign-up' ? 'Sign in' : 'Create an account'}
          </button>
        </p>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-muted-foreground text-[12px] font-medium">{label}</span>
      {children}
    </label>
  )
}
