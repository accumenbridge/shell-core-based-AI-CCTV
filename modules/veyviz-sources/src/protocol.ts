export const FIXTURE_ID = 'mivia-vid0062' as const;
export interface VideoSource {
  id: string;
  tenant: string;
  name: string;
  fixtureId: typeof FIXTURE_ID;
  version: number;
  created: number;
}
export type SourceView = Omit<VideoSource, 'tenant'>;

export interface SourceQueryRequest {
  q?: string;
  renamedOnly?: boolean;
  limit?: number;
  cursor?: string;
}

export interface SourceQueryPage {
  limit: number;
  nextCursor?: string;
  coverage: 'filtered-owner-query';
}

export interface SourceQueryResponse {
  items: SourceView[];
  page: SourceQueryPage;
}

export function sourceView(row: VideoSource): SourceView {
  return { id: row.id, name: row.name, fixtureId: row.fixtureId, version: row.version, created: row.created };
}
