import { Button } from "@cloudsync/ui/components/button"
import { Input } from "@cloudsync/ui/components/input"
import {
  CheckCircle2,
  Cloud,
  ExternalLink,
  FolderOpen,
  LogOut,
  RefreshCw,
  UploadCloud,
} from "lucide-react"
import { type FormEvent, useEffect, useState } from "react"
import { actions, authStepAtom, busyAtom, noticeAtom, stateAtom } from "./state"
import { useAtomValue } from "./use-atom"

const fileName = (path: string) => path.split("/").at(-1) ?? path

export function App() {
  const state = useAtomValue(stateAtom)
  const busy = useAtomValue(busyAtom)
  useEffect(() => {
    let unsubscribe = () => {}
    void actions.boot().then((dispose) => {
      unsubscribe = dispose
    })
    return () => unsubscribe()
  }, [])

  if (!state.authenticated) return <Login busy={busy} email={state.email} error={state.error} />

  return (
    <main className="window-shell">
      <header className="hero">
        <Cloud size={28} strokeWidth={1.5} />
        <div>
          <h1>CloudSync</h1>
          <p>Anything added to the inbox is uploaded, verified, then removed from this Mac.</p>
        </div>
      </header>

      <section className="inbox-card">
        <div className="inbox-label">Watched inbox → CloudSync /</div>
        <div className="path" title={state.watching ?? undefined}>
          {state.watching ?? "No folder selected"}
        </div>
        <div className="inbox-actions">
          <Button variant="outline" onClick={() => void actions.chooseFolder()} disabled={busy}>
            <FolderOpen size={16} /> {state.watching ? "Change folder" : "Choose folder"}
          </Button>
          {state.watching ? (
            <Button variant="ghost" onClick={() => void actions.revealInbox()}>
              Show in Finder
            </Button>
          ) : null}
        </div>
      </section>

      <section className="metrics">
        <div>
          <strong>{state.pending + state.active.length}</strong>
          <span>waiting</span>
        </div>
        <div>
          <strong>{state.uploaded}</strong>
          <span>archived this session</span>
        </div>
        <div data-alert={state.failed.length > 0 || undefined}>
          <strong>{state.failed.length}</strong>
          <span>need attention</span>
        </div>
      </section>

      {state.active.length > 0 ? (
        <div className="activity">
          <UploadCloud size={18} />
          <span className="activity-name">
            Archiving {fileName(state.active[0] ?? "")}
            {state.active.length > 1 ? ` and ${state.active.length - 1} more` : ""}
          </span>
        </div>
      ) : state.watching ? (
        <div className="activity idle">
          <CheckCircle2 size={18} />
          <span>Inbox is caught up</span>
        </div>
      ) : (
        <div className="activity idle">
          <FolderOpen size={18} />
          <span>Choose a folder to start archiving</span>
        </div>
      )}

      {state.failed.length > 0 ? (
        <section className="failures">
          <div className="failure-head">
            <span>Couldn’t archive</span>
            <Button size="sm" variant="ghost" onClick={() => void actions.retry()} disabled={busy}>
              <RefreshCw size={14} />
              Retry all
            </Button>
          </div>
          {state.failed.map((failure) => (
            <div className="failure" key={failure.path}>
              <strong title={failure.path}>{fileName(failure.path)}</strong>
              <span>{failure.message}</span>
            </div>
          ))}
        </section>
      ) : null}
      {state.error ? <p className="error">{state.error}</p> : null}

      <footer className="window-footer">
        <span>{state.email}</span>
        <div>
          <Button size="sm" variant="ghost" onClick={() => void actions.openWebsite()}>
            <ExternalLink size={14} /> Website
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void actions.signOut()} disabled={busy}>
            <LogOut size={14} /> Sign out
          </Button>
        </div>
      </footer>
    </main>
  )
}

function Login({
  busy,
  email,
  error,
}: {
  busy: boolean
  email: string | null
  error: string | null
}) {
  const step = useAtomValue(authStepAtom)
  const notice = useAtomValue(noticeAtom)
  const [code, setCode] = useState("")

  useEffect(() => {
    if (step === "pin") setCode("")
  }, [step])

  const submitEmail = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const value = String(new FormData(event.currentTarget).get("email") ?? "").trim()
    if (value) void actions.requestPin(value)
  }
  const submitCode = (value: string) => {
    if (value.length === 6 && !busy) void actions.verifyPin(value)
  }

  return (
    <main className="login-shell">
      <Cloud size={34} strokeWidth={1.4} />
      <h1>CloudSync</h1>
      {step === "email" ? (
        <form key="email" onSubmit={submitEmail}>
          <p>Sign in with the owner email to receive a code.</p>
          <Input
            name="email"
            type="email"
            autoComplete="email"
            defaultValue={email ?? ""}
            autoFocus
            required
            placeholder="you@example.com"
          />
          {error ? <p className="error">{error}</p> : null}
          <Button disabled={busy}>{busy ? "Sending…" : "Send code"}</Button>
        </form>
      ) : (
        <form
          key="pin"
          onSubmit={(event) => {
            event.preventDefault()
            submitCode(code)
          }}
        >
          <p>
            Enter the six-digit code sent to <strong>{email}</strong>.
          </p>
          <Input
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            autoFocus
            required
            placeholder="••••••"
            className="pin"
            value={code}
            onChange={(event) => {
              const next = event.target.value.replaceAll(/\D/g, "").slice(0, 6)
              setCode(next)
              submitCode(next)
            }}
          />
          {error ? <p className="error">{error}</p> : null}
          {notice ? <p className="notice">{notice}</p> : null}
          <Button disabled={busy || code.length !== 6}>{busy ? "Checking…" : "Sign in"}</Button>
          <div className="login-links">
            <button type="button" onClick={actions.changeEmail} disabled={busy}>
              Use a different email
            </button>
            <button type="button" onClick={() => void actions.resendPin()} disabled={busy}>
              Resend code
            </button>
          </div>
        </form>
      )}
    </main>
  )
}
