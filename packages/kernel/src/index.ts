export {
  MapEntityStore,
  storeFromSnapshot,
  type Command,
  type DiffAlgebra,
  type DispatchResult,
  type EntityStore,
  type ReadonlyEntityState,
  type Snapshot,
  type StateEngine,
  type TxEvent,
  type TxOrigin,
} from './ports';
export { SarError, type SarErrorCode } from './errors';
export {
  isGranted,
  PROGRAM_CALLER,
  type CallerInfo,
  type EntryKind,
} from './permissions';
export { createServices, type Services } from './services';
export {
  inputJsonSchemaOf,
  outputJsonSchemaOf,
  toValidationIssues,
  type JsonSchema,
  type ValidationIssue,
} from './schema-utils';
export {
  defineCapability,
  resolveEffects,
  type Capability,
  type CapabilityContext,
  type CapabilityKind,
  type CapabilityPack,
  type CapabilityResult,
  type EffectDescriptor,
} from './capability';
export { EventBus, type SarEvent } from './eventbus';
export {
  newRequestId,
  newRunId,
  newTraceId,
  type ExecutionIdentity,
  type ExecutionMode,
} from './ids';
export {
  SAR_IDEMPOTENCY_HEADER,
  SAR_IDEMPOTENT_REPLAY_HEADER,
  SAR_PROTOCOL_HEADER,
  SAR_REQUEST_ID_HEADER,
  SAR_WIRE_VERSION,
  type WireError,
  type WireErrorCode,
} from './wire';
export {
  CapabilityRegistry,
  type CapabilityDescriptor,
  type DescribeFilter,
} from './registry';
export { ReplayDiffCommand, TransactionGroup } from './txgroup';
export {
  Dispatcher,
  type BeginGroupOptions,
  type CurrentExecution,
  type InvokeError,
  type InvokeOptions,
  type InvokeOutcome,
  type Middleware,
  type MiddlewareContext,
  type TxGroupHandle,
} from './dispatcher';
export {
  WorkflowRegistry,
  type Workflow,
  type WorkflowRunOptions,
  type WorkflowRunResult,
  type WorkflowScope,
  type WorkflowStep,
} from './workflow';
export { toPaletteItems, type PaletteItem } from './palette';
export { createKernel, type KernelOptions, type SarKernel } from './kernel';
export {
  createErrorMonitor,
  explainError,
  suggestCapabilityIds,
  type ErrorMonitor,
  type ErrorReport,
  type InvokeFailure,
} from './diagnostics';
export {
  formatDoctorReport,
  runDoctor,
  type DoctorCheck,
  type DoctorLevel,
  type DoctorOptions,
  type DoctorReport,
} from './doctor';
export {
  createAuditLog,
  type AuditEntry,
  type AuditFilter,
  type AuditLog,
  type CreateAuditLogOptions,
} from './audit';
export {
  createJournal,
  parseJournal,
  replayJournal,
  type CreateJournalOptions,
  type Journal,
  type JournalEntry,
  type ReplayResult,
  type StreamSink,
} from './journal';
export {
  jsonClone,
  memoryStore,
  type SarStore,
  type StoreRecord,
  type StreamReadOptions,
} from './store';
export {
  CATALOG_SERVICE_KEY,
  CHECKPOINT_SERVICE_KEY,
  createRuntimePack,
  type CatalogService,
  type CheckpointService,
  type CreateRuntimePackOptions,
} from './runtime-pack';
export {
  createNamedSets,
  SETS_SERVICE_KEY,
  type NamedSet,
  type NamedSetService,
} from './named-sets';
export {
  createMemoryResourcePort,
  RESOURCES_SERVICE_KEY,
  type MemoryResourceSource,
  type ResourceDescriptor,
  type ResourcePort,
  type ResourceQuery,
  type ResourceQueryResult,
} from './resource';
export { createGuardrails, type Guardrails, type GuardrailsOptions } from './guardrails';
export {
  clientOf,
  type ClientDescribeFilter,
  type ClientInvokeOptions,
  type SarClient,
} from './client';
export {
  createTuningReport,
  formatTuningReport,
  type CreateTuningReportOptions,
  type FewShotExample,
  type TuningReport,
  type TuningSuggestion,
} from './tuning';
