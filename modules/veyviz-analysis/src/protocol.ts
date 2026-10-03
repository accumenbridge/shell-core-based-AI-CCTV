import type { RequestContext } from '@quadbridge/contracts';
import type { SourceQueryRequest, SourceQueryResponse, SourceView } from '@quadbridge/veyviz-sources/protocol';

export const REQUEST_SCHEMA = 'veyviz.recorded-analysis.request.v1' as const;
export const RESULT_SCHEMA = 'veyviz.recorded-analysis.result.v1' as const;
export const PROFILE_ID = 'rfdetr-small-cpu-v1' as const;
export const JOB_KIND = 'veyviz.analysis.run.v1' as const;

export interface AnalysisScope {
  productId: string;
  instanceId: string;
  tenantId: string;
  actorId: string;
  actorKind: 'user' | 'service';
}
export interface AnalysisRequest {
  schema: typeof REQUEST_SCHEMA;
  jobId: string;
  commandId: string;
  scope: AnalysisScope;
  sourceId: string;
  sourceVersion: number;
  fixtureId: 'mivia-vid0062';
  profileId: typeof PROFILE_ID;
  frameCount: number;
  sampleStride: number;
}
export interface Detection { confidence: number; x1: number; y1: number; x2: number; y2: number }
export interface AnalysisSample {
  frameIndex: number;
  positionMs: number;
  width: number;
  height: number;
  inferenceMs: number;
  detections: Detection[];
  thumbnailJpegBase64?: string;
}
export interface AnalysisResult {
  schema: typeof RESULT_SCHEMA;
  status: 'SUCCEEDED';
  request: AnalysisRequest;
  sourceSha256: string;
  modelSha256: string;
  modelId: typeof PROFILE_ID;
  startedAt: string;
  completedAt: string;
  decodedFrames: number;
  samples: AnalysisSample[];
  coverage: 'UNCOMMISSIONED_RECORDING';
  occupancy: 'UNKNOWN';
  cleanup: { sourceClosed: true; inferenceClosed: true; retainedBytes: 0; outstandingLeases: 0 };
  versions: Record<string, string>;
}
export interface SourceIdentity { scope: AnalysisScope; requestId: string }
export interface ScopedSourceReader {
  list(ctx: RequestContext): SourceView[];
  get(ctx: RequestContext, sourceId: string): SourceView;
  getForActor(identity: SourceIdentity, sourceId: string, signal: AbortSignal): SourceView;
}
export interface ScopedSourceQueryReader {
  query(ctx: RequestContext, request: SourceQueryRequest): SourceQueryResponse;
}
export interface RunnerReadiness {
  status: 'READY' | 'UNAVAILABLE';
  profileId: typeof PROFILE_ID;
  fixtureId: 'mivia-vid0062';
  modelId: typeof PROFILE_ID;
  sourceSha256?: string;
  modelSha256?: string;
  inventorySha256?: string;
  versions: Record<string, string>;
  message?: string;
}
export interface RecordedRunner {
  run(request: AnalysisRequest, options: { signal: AbortSignal; assertCurrent(): void | Promise<void> }): Promise<AnalysisResult>;
  readiness(): Promise<RunnerReadiness>;
}
export interface AnalysisPorts { sources: ScopedSourceReader; sourcesQuery: ScopedSourceQueryReader; runner: RecordedRunner }
