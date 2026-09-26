import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { InfrastructureLive } from "./server/layers"
import { Worker } from "./server/services/worker"

const WorkerLive = Worker.layer.pipe(
  Layer.provideMerge(InfrastructureLive),
  Layer.provideMerge(BunServices.layer),
)

BunRuntime.runMain(
  Effect.scoped(Effect.flatMap(Worker, (worker) => worker.run).pipe(Effect.provide(WorkerLive))),
)
