import { createLogger, nullLogger, type Logger, type AgentEvent, type AgentEventListener, type Unsubscribe } from "@kern/protocol";

export class EventBus {
  private listeners = new Set<AgentEventListener>();
  private readonly logger: Logger;

  constructor(logger: Logger = nullLogger) {
    this.logger = logger;
  }

  emit(event: AgentEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.logger.error("event_listener_error", { error, type: event.type });
      }
    }
  }

  subscribe(listener: AgentEventListener): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  clear(): void {
    this.listeners.clear();
  }
}