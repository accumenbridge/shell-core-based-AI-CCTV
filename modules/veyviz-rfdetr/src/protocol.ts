export const PROFILE_SCHEMA = 'veyviz.recorded-profile.v1' as const;
export const INVENTORY_SCHEMA = 'veyviz.recorded-inventory.v1' as const;
export const REQUEST_SCHEMA = 'veyviz.recorded-analysis.request.v1' as const;
export const RESULT_SCHEMA = 'veyviz.recorded-analysis.result.v1' as const;
export const PROFILE_ID = 'rfdetr-small-cpu-v1' as const;
export const FIXTURE_ID = 'mivia-vid0062' as const;
export const MODEL_SHA256 = '0e0817f4cafa479ccba17662a142092932b0b10c98947e7cf60f3badd0f5c219' as const;
export const RECORDING_SHA256 = 'ea6b48e57c343027b169ee1357e6e85ea3b8d179ba70058c294d1b1ec8db2805' as const;
export const MAX_REQUEST_BYTES = 16 * 1024;
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export interface AnalysisScope { productId: string; instanceId: string; tenantId: string; actorId: string; actorKind: 'user' | 'service' }
export interface AnalysisRequest {
  schema: typeof REQUEST_SCHEMA; jobId: string; commandId: string; scope: AnalysisScope; sourceId: string; sourceVersion: number;
  fixtureId: typeof FIXTURE_ID; profileId: typeof PROFILE_ID; frameCount: number; sampleStride: number;
}
export interface Detection { confidence: number; x1: number; y1: number; x2: number; y2: number }
export interface AnalysisSample { frameIndex: number; positionMs: number; width: number; height: number; inferenceMs: number; detections: Detection[]; thumbnailJpegBase64?: string }
export interface Cleanup { sourceClosed: boolean; inferenceClosed: boolean; retainedBytes: number; outstandingLeases: number }
export interface AnalysisResult {
  schema: typeof RESULT_SCHEMA; status: 'SUCCEEDED'; request: AnalysisRequest; sourceSha256: string; modelSha256: string; modelId: typeof PROFILE_ID;
  startedAt: string; completedAt: string; decodedFrames: number; samples: AnalysisSample[]; coverage: 'UNCOMMISSIONED_RECORDING'; occupancy: 'UNKNOWN';
  cleanup: { sourceClosed: true; inferenceClosed: true; retainedBytes: 0; outstandingLeases: 0 }; versions: Record<string, string>;
}
export interface Profile {
  schema: typeof PROFILE_SCHEMA; profileId: typeof PROFILE_ID; fixtureId: typeof FIXTURE_ID; modelPath: string; recordingPath: string;
  modelSha256: typeof MODEL_SHA256; recordingSha256: typeof RECORDING_SHA256; pythonExecutable: string; runnerPath: string; inventoryPath: string;
}
export interface Readiness {
  status: 'READY' | 'UNAVAILABLE'; profileId: typeof PROFILE_ID; fixtureId: typeof FIXTURE_ID; modelId: typeof PROFILE_ID;
  sourceSha256: string; modelSha256: string; inventorySha256: string; verifiedAt: string; message: string; versions: Record<string, string>;
}
