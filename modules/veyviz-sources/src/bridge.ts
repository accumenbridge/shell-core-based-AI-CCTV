import { PlatformError, type RequestContext } from '@quadbridge/contracts';
import type { SourceQueryRequest, SourceQueryResponse, SourceView, VideoSource } from './protocol.js';

/** Product-owned source port. Consumers receive projections and never the owner's database. */
export interface SourceReader {
  list(ctx: RequestContext): SourceView[];
  get(ctx: RequestContext, sourceId: string): SourceView;
}

/** Bounded, owner-filtered source queries for Product views and reviewed consumers. */
export interface SourceQueryReader {
  query(ctx: RequestContext, request: SourceQueryRequest): SourceQueryResponse;
}

export function requireSource(row: VideoSource | undefined): VideoSource {
  if (!row) throw new PlatformError('NOT_FOUND', 'Video source not found');
  return row;
}
