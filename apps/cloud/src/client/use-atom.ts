import type { Atom } from "effect/unstable/reactivity"
import { useCallback, useSyncExternalStore } from "react"
import { registry } from "./state"

export function useAtomValue<A>(atom: Atom.Atom<A>): A {
  const subscribe = useCallback(
    (listener: () => void) => registry.subscribe(atom, listener, { immediate: false }),
    [atom],
  )
  const getSnapshot = useCallback(() => registry.get(atom), [atom])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
