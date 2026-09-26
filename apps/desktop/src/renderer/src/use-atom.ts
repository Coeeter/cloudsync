import type { Atom } from "effect/unstable/reactivity"
import { useSyncExternalStore } from "react"
import { registry } from "./state"

export function useAtomValue<A>(atom: Atom.Atom<A>): A {
  return useSyncExternalStore(
    (notify) => registry.subscribe(atom, () => notify()),
    () => registry.get(atom),
    () => registry.get(atom),
  )
}
