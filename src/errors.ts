export class QuotaWeaveError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class ConfigurationError extends QuotaWeaveError {}

export class InvalidWorkItemError extends QuotaWeaveError {}

export class DuplicateWorkItemError extends QuotaWeaveError {}

export class UnknownLeaseError extends QuotaWeaveError {}

export class StaleFencingTokenError extends QuotaWeaveError {}

export class SimulationDeadlockError extends QuotaWeaveError {}
