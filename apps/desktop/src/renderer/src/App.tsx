import { Button } from "@cloudsync/ui/components/button"
import { Input } from "@cloudsync/ui/components/input"
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@cloudsync/ui/components/input-otp"
import {
  CheckCircle2,
  ExternalLink,
  FolderOpen,
  LogOut,
  RefreshCw,
  UploadCloud,
} from "lucide-react"
import { type FormEvent, useEffect, useState } from "react"
import appIconUrl from "../../../build/icon.svg"
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
    <main className="min-h-screen px-8 pt-16 pb-8 [-webkit-app-region:drag]">
      <header className="mb-8 flex items-start gap-3.5">
        <img className="-mt-1 size-10 shrink-0" src={appIconUrl} alt="" />
        <div>
          <h1 className="m-0 text-3xl tracking-tighter">CloudSync</h1>
          <p className="mt-1 mb-0 leading-normal text-muted-foreground">
            Anything added to the inbox is uploaded, verified, then removed from this Mac.
          </p>
        </div>
      </header>

      <section className="grid gap-2 rounded-xl border border-border bg-card p-5 [-webkit-app-region:no-drag]">
        <div className="text-xs tracking-[0.08em] text-muted-foreground uppercase">
          Watched inbox → CloudSync /
        </div>
        <div className="truncate font-mono text-xs" title={state.watching ?? undefined}>
          {state.watching ?? "No folder selected"}
        </div>
        <div className="flex gap-1.5">
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

      <section className="my-6 grid grid-cols-3 border-y border-border">
        <div className="grid gap-1 px-1.5 py-4 text-center">
          <strong className="font-mono text-2xl font-medium">
            {state.pending + state.active.length}
          </strong>
          <span className="text-xs text-muted-foreground">waiting</span>
        </div>
        <div className="grid gap-1 px-1.5 py-4 text-center">
          <strong className="font-mono text-2xl font-medium">{state.uploaded}</strong>
          <span className="text-xs text-muted-foreground">archived this session</span>
        </div>
        <div className="grid gap-1 px-1.5 py-4 text-center">
          <strong
            className={`font-mono text-2xl font-medium ${state.failed.length > 0 ? "text-destructive" : ""}`}
          >
            {state.failed.length}
          </strong>
          <span className="text-xs text-muted-foreground">need attention</span>
        </div>
      </section>

      {state.active.length > 0 ? (
        <div className="flex items-center gap-2 px-0.5 py-3 text-sm">
          <UploadCloud size={18} />
          <span className="truncate">
            Archiving {fileName(state.active[0] ?? "")}
            {state.active.length > 1 ? ` and ${state.active.length - 1} more` : ""}
          </span>
        </div>
      ) : state.watching ? (
        <div className="flex items-center gap-2 px-0.5 py-3 text-sm text-muted-foreground">
          <CheckCircle2 size={18} />
          <span>Inbox is caught up</span>
        </div>
      ) : (
        <div className="flex items-center gap-2 px-0.5 py-3 text-sm text-muted-foreground">
          <FolderOpen size={18} />
          <span>Choose a folder to start archiving</span>
        </div>
      )}

      {state.failed.length > 0 ? (
        <section className="mt-5 [-webkit-app-region:no-drag]">
          <div className="flex items-center justify-between text-sm text-destructive">
            <span>Couldn’t archive</span>
            <Button size="sm" variant="ghost" onClick={() => void actions.retry()} disabled={busy}>
              <RefreshCw size={14} />
              Retry all
            </Button>
          </div>
          {state.failed.map((failure) => (
            <div className="grid gap-1 border-t border-border py-2.5" key={failure.path}>
              <strong className="text-xs" title={failure.path}>
                {fileName(failure.path)}
              </strong>
              <span className="text-xs text-destructive">{failure.message}</span>
            </div>
          ))}
        </section>
      ) : null}
      {state.error ? <p className="text-xs text-destructive">{state.error}</p> : null}

      <footer className="mt-7 flex items-center justify-between border-t border-border pt-3.5 text-xs text-muted-foreground [-webkit-app-region:no-drag]">
        <span>{state.email}</span>
        <div className="flex gap-1">
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
    <main className="mx-auto grid min-h-screen max-w-sm content-center px-8 pt-16 pb-8 [-webkit-app-region:drag]">
      <img className="size-12 shrink-0" src={appIconUrl} alt="" />
      <h1 className="mt-2.5 text-3xl tracking-tighter">CloudSync</h1>
      {step === "email" ? (
        <form
          className="mt-6 grid gap-3 [-webkit-app-region:no-drag]"
          key="email"
          onSubmit={submitEmail}
        >
          <p className="mt-1 mb-0 leading-normal text-muted-foreground">
            Sign in with the owner email to receive a code.
          </p>
          <Input
            name="email"
            type="email"
            autoComplete="email"
            defaultValue={email ?? ""}
            autoFocus
            required
            placeholder="you@example.com"
            className="h-12 rounded-lg border-border bg-card px-3 text-base text-foreground focus-visible:border-ring"
          />
          {error ? <p className="m-0 text-xs text-destructive">{error}</p> : null}
          <Button disabled={busy}>{busy ? "Sending…" : "Send code"}</Button>
        </form>
      ) : (
        <form
          className="mt-6 grid gap-3 [-webkit-app-region:no-drag]"
          key="pin"
          onSubmit={(event) => {
            event.preventDefault()
            submitCode(code)
          }}
        >
          <p className="mt-1 mb-0 leading-normal text-muted-foreground">
            Enter the six-digit code sent to{" "}
            <strong className="font-[540] text-foreground">{email}</strong>.
          </p>
          <InputOTP
            name="code"
            autoComplete="one-time-code"
            maxLength={6}
            autoFocus
            required
            pattern="[0-9]*"
            value={code}
            onChange={setCode}
            onComplete={submitCode}
            containerClassName="w-full"
          >
            <InputOTPGroup className="w-full">
              {[0, 1, 2, 3, 4, 5].map((index) => (
                <InputOTPSlot
                  className="h-12 flex-1 bg-card font-mono text-xl"
                  index={index}
                  key={index}
                />
              ))}
            </InputOTPGroup>
          </InputOTP>
          {error ? <p className="m-0 text-xs text-destructive">{error}</p> : null}
          {notice ? <p className="m-0 text-xs text-muted-foreground">{notice}</p> : null}
          <Button disabled={busy || code.length !== 6}>{busy ? "Checking…" : "Sign in"}</Button>
          <div className="flex justify-between">
            <button
              className="border-0 bg-transparent px-0 py-1 text-xs text-muted-foreground hover:not-disabled:text-foreground"
              type="button"
              onClick={actions.changeEmail}
              disabled={busy}
            >
              Use a different email
            </button>
            <button
              className="border-0 bg-transparent px-0 py-1 text-xs text-muted-foreground hover:not-disabled:text-foreground"
              type="button"
              onClick={() => void actions.resendPin()}
              disabled={busy}
            >
              Resend code
            </button>
          </div>
        </form>
      )}
    </main>
  )
}
