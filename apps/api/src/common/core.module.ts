import { Global, Injectable, Module } from "@nestjs/common";

/**
 * The wall clock, behind an injectable seam.
 *
 * `packages/domain` forbids clock access entirely and takes an injected Clock
 * (AGENT.md §17). The API is an adapter and may read the real time, but it
 * reads it in ONE place so an integration test can freeze it — which is what
 * makes session expiry and idle timeout testable without waiting two hours.
 */
@Injectable()
export class ClockService {
  now(): Date {
    return new Date();
  }
}

@Global()
@Module({
  providers: [ClockService],
  exports: [ClockService],
})
export class CoreModule {}
