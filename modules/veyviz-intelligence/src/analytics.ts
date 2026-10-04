import { randomUUID } from 'node:crypto';
import { canonical, id, integer, object, PlatformError, text, type RequestContext } from '@quadbridge/contracts';
import type { SqliteOwner } from '@quadbridge/sqlite';
import type { Appearance, Category, TemporalResult } from './protocol.js';
import { cosine } from './features.js';

export const ANALYTICS_SQL = `
CREATE TABLE intelligence_rules(tenant TEXT NOT NULL,id TEXT NOT NULL,version INTEGER NOT NULL,source_id TEXT NOT NULL,record_json TEXT NOT NULL,PRIMARY KEY(tenant,id));
CREATE TABLE intelligence_alerts(tenant TEXT NOT NULL,id TEXT NOT NULL,run_id TEXT NOT NULL,rule_id TEXT NOT NULL,event_id TEXT NOT NULL,state TEXT NOT NULL,record_json TEXT NOT NULL,PRIMARY KEY(tenant,id),UNIQUE(tenant,run_id,rule_id,event_id));
CREATE TABLE intelligence_entities(tenant TEXT NOT NULL,id TEXT NOT NULL,category TEXT NOT NULL,label TEXT NOT NULL,PRIMARY KEY(tenant,id));
CREATE TABLE intelligence_links(tenant TEXT NOT NULL,run_id TEXT NOT NULL,appearance_id TEXT NOT NULL,entity_id TEXT NOT NULL,actor_id TEXT NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(tenant,run_id,appearance_id));
CREATE TABLE intelligence_batches(tenant TEXT NOT NULL,id TEXT NOT NULL,record_json TEXT NOT NULL,PRIMARY KEY(tenant,id));
CREATE TABLE intelligence_watches(tenant TEXT NOT NULL,id TEXT NOT NULL,active INTEGER NOT NULL,record_json TEXT NOT NULL,error TEXT,PRIMARY KEY(tenant,id));
CREATE TABLE intelligence_watch_seen(tenant TEXT NOT NULL,watch_id TEXT NOT NULL,recording_id TEXT NOT NULL,run_id TEXT NOT NULL,PRIMARY KEY(tenant,watch_id,recording_id));
CREATE TABLE intelligence_families(tenant TEXT NOT NULL,source_id TEXT NOT NULL,family_id TEXT NOT NULL,PRIMARY KEY(tenant,source_id));
`;
interface Rule { id: string; version: number; sourceId: string; name: string; category: Category | ''; type: 'zone_entered' | 'zone_exited' | 'presence' | 'dwell'; zoneId: string; dwellMs: number; enabled: boolean }
export function ruleInput(value: unknown) {
  const raw = object(value, ['sourceId', 'name', 'category', 'type', 'zoneId', 'dwellMs', 'enabled']);
  if (!['', 'person', 'vehicle', 'animal'].includes(raw.category as string) || !['zone_entered', 'zone_exited', 'presence', 'dwell'].includes(raw.type as string) || typeof raw.enabled !== 'boolean') throw new PlatformError('INVALID', 'Invalid alert rule');
  return { sourceId: id(raw.sourceId), name: text(raw.name, 'name', 100), category: raw.category as Rule['category'], type: raw.type as Rule['type'], zoneId: raw.zoneId === '' ? '' : id(raw.zoneId), dwellMs: integer(raw.dwellMs, 0, 120000), enabled: raw.enabled };
}
export function adoptAlerts(store: SqliteOwner, tenant: string, sourceId: string, runId: string, result: TemporalResult) {
  const family = store.db.prepare('SELECT family_id FROM intelligence_families WHERE tenant=? AND source_id=?').get(tenant, sourceId) as { family_id: string } | undefined;
  const rules = (store.db.prepare('SELECT record_json FROM intelligence_rules WHERE tenant=? AND source_id IN (?,?) ORDER BY id').all(tenant, sourceId, family?.family_id ?? sourceId) as { record_json: string }[]).map(row => JSON.parse(row.record_json) as Rule).filter(rule => rule.enabled);
  for (const rule of rules) {
    const evidence = rule.type === 'dwell' ? result.visits.filter(visit => visit.enteredMs !== null && visit.lastMs - visit.enteredMs >= rule.dwellMs && (!rule.zoneId || visit.zoneId === rule.zoneId)).map(visit => ({ id: visit.id, appearanceId: visit.appearanceId, positionMs: visit.lastMs, zoneId: visit.zoneId })) : result.events.filter(event => event.type === rule.type && (!rule.zoneId || event.zoneId === rule.zoneId));
    for (const event of evidence) {
      const appearance = result.appearances.find(a => a.id === event.appearanceId)!;
      if (rule.category && rule.category !== appearance.category) continue;
      const alert = { id: randomUUID(), runId, sourceId, ruleId: rule.id, ruleVersion: rule.version, name: rule.name, category: appearance.category, type: rule.type, appearanceId: appearance.id, eventId: rule.type === 'dwell' ? result.events.find(e => e.appearanceId === appearance.id)?.id ?? null : event.id, evidenceId: event.id, positionMs: event.positionMs, zoneId: event.zoneId, state: 'UNACKNOWLEDGED', qualification: 'AI_REVIEW_REQUIRED', created: Date.now(), acknowledgedBy: null };
      store.db.prepare('INSERT OR IGNORE INTO intelligence_alerts VALUES(?,?,?,?,?,?,?)').run(tenant, alert.id, runId, rule.id, event.id, alert.state, canonical(alert));
    }
  }
}
export function createAnalytics(store: SqliteOwner, readRun: (ctx: RequestContext, runId: string) => { id: string; result_json: string | null }) {
  const permission = 'veyviz.intelligence.write';
  return {
    rules(ctx: RequestContext) { ctx.assertAllowed('veyviz.intelligence.read', 'read'); return { items: (store.db.prepare('SELECT record_json FROM intelligence_rules WHERE tenant=? ORDER BY id LIMIT 100').all(ctx.tenantId) as { record_json: string }[]).map(row => JSON.parse(row.record_json)) }; },
    saveRule(ctx: RequestContext, input: unknown, key: string, assertSource: (sourceId: string, zoneId: string) => void) {
      ctx.assertAllowed(permission, 'write'); const raw = object(input, ['sourceId','name','category','type','zoneId','dwellMs','enabled','ruleId','version']);
      const { ruleId, version, ...fields } = raw, rule = ruleInput(fields); assertSource(rule.sourceId, rule.enabled ? rule.zoneId : '');
      if ((ruleId === undefined) !== (version === undefined)) throw new PlatformError('INVALID', 'Rule identity and version are required together');
      const target = ruleId === undefined ? undefined : { id: id(ruleId), version: integer(version,1,Number.MAX_SAFE_INTEGER) };
      return store.command(ctx, 'veyviz.intelligence.rule', key, { ...rule, ...(target ? { target } : {}) }, permission, () => {
        if (target) {
          const row = store.db.prepare('SELECT version,source_id FROM intelligence_rules WHERE tenant=? AND id=?').get(ctx.tenantId,target.id) as { version: number; source_id: string } | undefined;
          if (!row) throw new PlatformError('NOT_FOUND','Rule not found');
          if (row.version !== target.version || row.source_id !== rule.sourceId) throw new PlatformError('CONFLICT','Rule changed; reload before saving');
          const updated = { ...rule, id: target.id, version: target.version+1 };
          store.db.prepare('UPDATE intelligence_rules SET version=?,record_json=? WHERE tenant=? AND id=?').run(updated.version,canonical(updated),ctx.tenantId,target.id); return updated;
        }
        const count = store.db.prepare('SELECT COUNT(*) AS n FROM intelligence_rules WHERE tenant=?').get(ctx.tenantId) as { n: number };
        if (count.n >= 100) throw new PlatformError('EXHAUSTED', 'Rule limit reached');
        const created = { ...rule, id: randomUUID(), version: 1 };
        store.db.prepare('INSERT INTO intelligence_rules VALUES(?,?,?,?,?)').run(ctx.tenantId, created.id, 1, created.sourceId, canonical(created)); return created;
      });
    },
    alerts(ctx: RequestContext, query: URLSearchParams) {
      ctx.assertAllowed('veyviz.intelligence.read', 'read'); const state = query.get('state') ?? '';
      if (!['', 'UNACKNOWLEDGED', 'ACKNOWLEDGED'].includes(state)) throw new PlatformError('INVALID', 'Invalid alert state');
      return { items: (store.db.prepare("SELECT record_json FROM intelligence_alerts WHERE tenant=? AND (?='' OR state=?) ORDER BY rowid DESC LIMIT 100").all(ctx.tenantId, state, state) as { record_json: string }[]).map(row => JSON.parse(row.record_json)) };
    },
    acknowledge(ctx: RequestContext, input: unknown, key: string) {
      const raw = object(input, ['alertId']), alertId = id(raw.alertId);
      return store.command(ctx, 'veyviz.intelligence.acknowledge', key, { alertId }, permission, () => {
        const row = store.db.prepare('SELECT record_json FROM intelligence_alerts WHERE tenant=? AND id=?').get(ctx.tenantId, alertId) as { record_json: string } | undefined;
        if (!row) throw new PlatformError('NOT_FOUND', 'Alert not found');
        const alert = JSON.parse(row.record_json); if (alert.state === 'ACKNOWLEDGED') return alert;
        alert.state = 'ACKNOWLEDGED'; alert.acknowledgedBy = ctx.actor.id;
        store.db.prepare('UPDATE intelligence_alerts SET state=?,record_json=? WHERE tenant=? AND id=?').run(alert.state, canonical(alert), ctx.tenantId, alertId); return alert;
      });
    },
    link(ctx: RequestContext, input: unknown, key: string) {
      const raw = object(input, ['runId', 'appearanceId', 'entityId', 'label']), runId = id(raw.runId), appearanceId = id(raw.appearanceId), entityId = id(raw.entityId), label = text(raw.label, 'label', 80);
      const run = readRun(ctx, runId), result = JSON.parse(run.result_json ?? 'null') as TemporalResult | null, appearance = result?.appearances.find(a => a.id === appearanceId);
      if (!appearance) throw new PlatformError('NOT_FOUND', 'Accepted appearance not found');
      return store.command(ctx, 'veyviz.intelligence.entity-link', key, { runId, appearanceId, entityId, label }, permission, () => {
        const entity = store.db.prepare('SELECT category,label FROM intelligence_entities WHERE tenant=? AND id=?').get(ctx.tenantId, entityId) as { category: string; label: string } | undefined;
        if (entity && (entity.category !== appearance.category || entity.label !== label)) throw new PlatformError('CONFLICT', 'Entity category or label conflicts with existing review');
        const overlaps = store.db.prepare('SELECT appearance_id FROM intelligence_links WHERE tenant=? AND run_id=? AND entity_id=? AND appearance_id<>?').all(ctx.tenantId, runId, entityId, appearanceId) as { appearance_id: string }[];
        if (overlaps.some(link => { const other = result!.appearances.find(a => a.id === link.appearance_id)!; return Math.max(other.firstMs, appearance.firstMs) <= Math.min(other.lastMs, appearance.lastMs); })) throw new PlatformError('CONFLICT', 'Overlapping appearances cannot represent the same reviewed entity in one run');
        const count = store.db.prepare('SELECT COUNT(*) AS n FROM intelligence_entities WHERE tenant=?').get(ctx.tenantId) as { n: number };
        if (!entity && count.n >= 10000) throw new PlatformError('EXHAUSTED', 'Reviewed entity limit reached');
        store.db.prepare('INSERT OR IGNORE INTO intelligence_entities VALUES(?,?,?,?)').run(ctx.tenantId, entityId, appearance.category, label);
        store.db.prepare('INSERT INTO intelligence_links VALUES(?,?,?,?,?,?) ON CONFLICT(tenant,run_id,appearance_id) DO UPDATE SET entity_id=excluded.entity_id,actor_id=excluded.actor_id,created=excluded.created').run(ctx.tenantId, runId, appearanceId, entityId, ctx.actor.id, Date.now());
        return { runId, appearanceId, entityId, label, category: appearance.category, review: 'HUMAN_LINKED_ANONYMOUS_ENTITY' };
      });
    },
    summary(ctx: RequestContext, runIds: string[]) {
      if (!runIds.length || runIds.length > 100 || new Set(runIds).size !== runIds.length) throw new PlatformError('INVALID', 'Select one to 100 distinct accepted runs');
      let bytes = 0;
      const runs = runIds.map(runId => { const row = readRun(ctx, runId); if (!row.result_json) throw new PlatformError('CONFLICT', 'Summary requires accepted runs'); bytes += Buffer.byteLength(row.result_json); if (bytes > 32 * 1024 * 1024) throw new PlatformError('EXHAUSTED', 'Narrow the summary to at most 32 MiB of accepted evidence'); return { runId: row.id, result: JSON.parse(row.result_json) as TemporalResult }; });
      const appearances = runs.flatMap(run => run.result.appearances.map(a => ({ ...a, runId: run.runId })));
      const entries = runs.flatMap(run => run.result.events.filter(e => e.type === 'zone_entered'));
      const categories = Object.fromEntries((['person', 'vehicle', 'animal'] as Category[]).map(category => {
        const selected = appearances.filter(a => a.category === category), groups: (typeof selected)[] = [];
        for (const appearance of selected) {
          const match = groups.find(group => {
            if (group.some(other => other.runId === appearance.runId && Math.max(other.firstMs, appearance.firstMs) <= Math.min(other.lastMs, appearance.lastMs))) return false;
            const other = group[0]!;
            const a = category === 'person' && appearance.faceVector && other.faceVector ? appearance.faceVector : appearance.visualVector;
            const b = category === 'person' && appearance.faceVector && other.faceVector ? other.faceVector : other.visualVector;
            return !!a && !!b && (cosine(a, b) ?? -1) >= (a === appearance.faceVector ? .65 : .97);
          });
          if (match) match.push(appearance); else groups.push([appearance]);
        }
        const entities = new Set<string>(); let linked = 0;
        for (const appearance of selected) { const link = store.db.prepare('SELECT entity_id FROM intelligence_links WHERE tenant=? AND run_id=? AND appearance_id=?').get(ctx.tenantId, appearance.runId, appearance.id) as { entity_id: string } | undefined; if (link) { entities.add(link.entity_id); linked++; } }
        return [category, { trackedAppearances: selected.length, zoneEntries: entries.filter(e => e.category === category).length, possibleVisualGroups: groups.length, reviewedEntities: entities.size, unreviewedAppearances: selected.length - linked, uniquePhysicalEntities: null }];
      }));
      const activity = runs.flatMap(run => run.result.appearances.map(a => ({ runId: run.runId, appearanceId: a.id, category: a.category, description: a.description, firstMs: a.firstMs, lastMs: a.lastMs, observedSpanMs: a.lastMs - a.firstMs, observations: a.observations, events: run.result.events.filter(e => e.appearanceId === a.id), visits: run.result.visits.filter(v => v.appearanceId === a.id) })));
      return { runIds, categories, activity, summary: `${appearances.length} tracked appearances across ${runs.length} accepted runs; ${entries.length} measured polygon entries. Physical uniqueness and occupancy are not established.`, qualification: 'ACCEPTED_SAMPLED_FACTS', generatedAt: Date.now() };
    }
  };
}
