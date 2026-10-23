import type { ScheduleHint } from '@/services/vectorise/shared/types';

export type TranscribableNodeKind = 'voice' | 'resource';

export interface TranscribeDispatchTickResult {
  status: 'success' | 'idle' | 'skipped' | 'dispatch_failed' | 'error';
  message?: string;
  nodeKind?: TranscribableNodeKind;
  nodeId?: string;
  jobId?: string;
  dispatchError?: string;
  dispatched: number;
  failed: number;
  outstanding: number;
  schedule: ScheduleHint;
}
