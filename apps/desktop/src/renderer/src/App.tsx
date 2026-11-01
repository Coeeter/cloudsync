import { Button } from "@cloudsync/ui/components/button"
import {
  CheckCircle2,
  ExternalLink,
  FolderOpen,
  LogOut,
  RefreshCw,
  UploadCloud,
} from "lucide-react"
import { useEffect } from "react"
import appIconUrl from "../../../build/icon.svg"
import { actions, busyAtom, stateAtom } from "./state"
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

  if (state.missingTools.length)
    return (
      <main className="grid min-h-screen content-center gap-4 px-8 pt-16 pb-8">
        <h1 className="text-2xl tracking-tight">Install preview tools</h1>
        <p>CloudSync needs {state.missingTools.join(", ")} before it can archive files.</p>
        <p>Run this in Terminal, then quit and restart CloudSync:</p>
        <code className="select-all rounded-lg bg-card p-4 text-sm">
          brew install ffmpeg poppler webp
        </code>
        <Button
          onClick={() => void navigator.clipboard.writeText("brew install ffmpeg poppler webp")}
        >
          Copy command
        </Button>
        <p className="text-sm text-muted-foreground">
          Archiving is paused until the tools are installed.
        </p>
      </main>
    )

  if (!state.authenticated) return <Login busy={busy} error={state.error} />

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

function Login({ busy, error }: { busy: boolean; error: string | null }) {
  return (
    <main className="mx-auto grid min-h-screen max-w-sm content-center px-8 pt-16 pb-8 [-webkit-app-region:drag]">
      <img className="size-12 shrink-0" src={appIconUrl} alt="" />
      <h1 className="mt-2.5 text-3xl tracking-tighter">CloudSync</h1>
      <div className="mt-6 grid gap-3 [-webkit-app-region:no-drag]">
        <p className="mt-1 mb-0 leading-normal text-muted-foreground">
          {busy
            ? "Finish signing in in your browser, then come back here."
            : "Sign in through your browser to start archiving."}
        </p>
        {error && !busy ? <p className="m-0 text-xs text-destructive">{error}</p> : null}
        {/* Clicking again restarts the flow, in case the browser tab was closed. */}
        <Button onClick={() => void actions.signIn()}>
          {busy ? "Open the browser again" : "Sign in with browser"}
        </Button>
      </div>
    </main>
  )
}
