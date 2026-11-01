import { Effect } from "effect"
import { Atom, AtomRegistry } from "effect/unstable/reactivity"
import type { DesktopSnapshot } from "../../main"

const empty: DesktopSnapshot = {
  missingTools: [],
  watching: null,
  pending: 0,
  active: [],
  failed: [],
  uploaded: 0,
  signInExpired: false,
  authenticated: false,
  email: null,
  cloudUrl: "",
  error: null,
}

export const registry = AtomRegistry.make()
export const stateAtom = Atom.make<DesktopSnapshot>(empty)
export const busyAtom = Atom.make(false)

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
  signIn: () => run(() => window.cloudsync.signIn()),
  signOut: () => run(() => window.cloudsync.signOut()),
  chooseFolder: () => run(() => window.cloudsync.chooseFolder()),
  retry: () => run(() => window.cloudsync.retry()),
  openWebsite: () => run(() => window.cloudsync.openWebsite()),
  revealInbox: () => run(() => window.cloudsync.revealInbox()),
}
