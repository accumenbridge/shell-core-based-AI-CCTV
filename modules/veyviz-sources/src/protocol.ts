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

export function sourceView(row: VideoSource): SourceView {
  return { id: row.id, name: row.name, fixtureId: row.fixtureId, version: row.version, created: row.created };
}
