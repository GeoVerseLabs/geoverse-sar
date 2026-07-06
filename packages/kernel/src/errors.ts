export type SarErrorCode =
  | 'capability_not_found'
  | 'capability_conflict'
  | 'permission_denied'
  | 'validation_failed'
  | 'handler_error'
  | 'engine_rejected'
  | 'tx_group_not_found'
  | 'workflow_not_found'
  | 'workflow_conflict'
  | 'workflow_aborted';

export class SarError extends Error {
  constructor(
    readonly code: SarErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'SarError';
  }
}
