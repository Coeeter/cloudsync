import { Effect } from "effect"
import { Atom, AtomRegistry } from "effect/unstable/reactivity"
import type { DesktopSnapshot } from "../../main"

const empty: DesktopSnapshot = {
  watching: null,
  pending: 0,
  active: [],
  failed: [],
  uploaded: 0,
  authenticated: false,
  email: null,
  cloudUrl: "",
  error: null,
}

export const registry = AtomRegistry.make()
export const stateAtom = Atom.make<DesktopSnapshot>(empty)
export const authStepAtom = Atom.make<"email" | "pin">("email")
export const busyAtom = Atom.make(false)
export const noticeAtom = Atom.make<string | null>(null)

// Main-process handlers resolve to an error message (or null) and also publish it in the snapshot.
const run = (operation: () => Promise<string | null>) =>
  Effect.runPromise(
    Effect.sync(() => registry.set(busyAtom, true)).pipe(
      Effect.andThen(Effect.promise(operation)),
      Effect.orElseSucceed(() => "CloudSync could not complete that operation"),
      Effect.ensuring(Effect.sync(() => registry.set(busyAtom, false))),
    ),
  )

export const actions = {
  boot: async () => {
    registry.set(stateAtom, await window.cloudsync.state())
    return window.cloudsync.onState((state) => registry.set(stateAtom, state))
  },
  requestPin: async (email: string) => {
    registry.set(noticeAtom, null)
    if ((await run(() => window.cloudsync.requestPin(email))) === null)
      registry.set(authStepAtom, "pin")
  },
  resendPin: async () => {
    const email = registry.get(stateAtom).email
    if (!email) return registry.set(authStepAtom, "email")
    if ((await run(() => window.cloudsync.requestPin(email))) === null)
      registry.set(noticeAtom, "A new code was sent.")
  },
  changeEmail: () => {
    registry.set(noticeAtom, null)
    registry.set(authStepAtom, "email")
  },
  verifyPin: (code: string) => run(() => window.cloudsync.verifyPin(code)),
  signOut: async () => {
    await run(() => window.cloudsync.signOut())
    registry.set(authStepAtom, "email")
  },
  chooseFolder: () => run(() => window.cloudsync.chooseFolder()),
  retry: () => run(() => window.cloudsync.retry()),
  openWebsite: () => run(() => window.cloudsync.openWebsite()),
  revealInbox: () => run(() => window.cloudsync.revealInbox()),
}
