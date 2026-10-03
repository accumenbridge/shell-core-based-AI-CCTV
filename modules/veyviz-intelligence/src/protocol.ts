export const REQUEST_SCHEMA = 'veyviz.temporal-recording.request.v1' as const;
export const RESULT_SCHEMA = 'veyviz.temporal-recording.result.v1' as const;
export const JOB_KIND = 'veyviz.intelligence.recorded.v1' as const;
export type Point = [number, number];
export interface Zone { id: string; points: Point[] }
export interface Geometry { version: number; zones: Zone[] }
export type Category = 'person' | 'vehicle' | 'animal';
export interface Processing {
  categories: Category[]; execution: 'CPU' | 'CUDA';
  motion: { enabled: boolean; threshold: number; heartbeatMs: number };
  visual: boolean; face: boolean; plate: boolean; runtimeSha256: string;
}
export interface FeatureVector { model: string; values: number[] }
export interface Recording {
  id: string; tenantId: string; name: string; path: string; sha256: string; bytes: number;
  captureStartUtc: string | null; clockUncertaintyMs: number | null;
}
export type RecordingView = Omit<Recording, 'path' | 'tenantId'>;
export interface Source extends RecordingView { sourceId: string; version: number; geometry: Geometry }
export interface TemporalRequest {
  schema: typeof REQUEST_SCHEMA; jobId: string; runId: string; commandId: string;
  scope: { productId: string; instanceId: string; tenantId: string; actorId: string; actorKind: 'user' | 'service' };
  sourceId: string; sourceVersion: number; recordingId: string; sourceSha256: string; pipelineSha256: string;
  startMs: number; endMs: number; sampleIntervalMs: number; geometry: Geometry; processing?: Processing;
}
export interface Appearance {
  id: string; category: Category; firstMs: number; lastMs: number; observations: number;
  confidence: number; description: string; thumbnailJpegBase64?: string;
  label?: string; visualVector?: FeatureVector; faceVector?: FeatureVector;
  plateCandidates?: { text: string; confidence: number }[];
}
export interface Event {
  id: string; appearanceId: string; category: Category; type: 'presence' | 'zone_entered' | 'zone_exited';
  positionMs: number; zoneId: string | null;
}
export interface Visit { id: string; appearanceId: string; zoneId: string; enteredMs: number | null; lastMs: number; exitedMs: number | null; state: 'OPEN' | 'CLOSED' | 'UNCERTAIN' }
export interface TemporalResult {
  schema: typeof RESULT_SCHEMA; status: 'SUCCEEDED'; request: TemporalRequest;
  sourceSha256: string; modelSha256: string; pipelineSha256: string; originPtsMs: number; decodedFrames: number;
  coverage: { policy: 'SAMPLED_UNCOMMISSIONED'; observedMs: number[]; endReason: 'WINDOW_END' | 'RECORDING_END' };
  appearances: Appearance[]; events: Event[]; visits: Visit[];
  processingEvidence?: { runtimeSha256: string; execution: 'CPU' | 'CUDA'; consideredMs: number[]; motionSkippedMs: number[]; featureModels: Record<string, string> };
  cleanup: { sourceClosed: true; inferenceClosed: true; retainedBytes: 0; outstandingLeases: 0 };
}
export interface TemporalRunner {
  run(request: TemporalRequest, recording: Recording, options: { signal: AbortSignal; assertCurrent(): void | Promise<void> }): Promise<TemporalResult>;
  close(): Promise<void>;
}
