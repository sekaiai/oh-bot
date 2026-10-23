export class CompanionError extends Error {
  constructor(readonly code: string, message = code) { super(message); this.name = 'CompanionError'; }
}
