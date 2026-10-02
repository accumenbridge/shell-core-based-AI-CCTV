import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { SqliteOwner } from '@quadbridge/sqlite';
import { PlatformError, type Actor, type Mode, type Scope } from '@quadbridge/contracts';
export interface Grant {
    tenantId: string;
    permissions: string[];
}
export interface PrincipalSeed {
    id: string;
    password?: string;
    serviceToken?: string;
    grants: Grant[];
}
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
export class LocalAccess {
    readonly store: SqliteOwner;
    private seedAvailable = false;
    constructor(path: string, private readonly scope: Omit<Scope, 'tenantId'>, private readonly clock: () => number = Date.now,
        initialPrincipals?: readonly PrincipalSeed[]) {
        this.store = new SqliteOwner(path, 'local-access');
        let wasUninitialized: boolean;
        try {
            const priorMigrations = this.store.db.prepare('SELECT version FROM _migrations').all();
            const priorAccessTables = this.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('instance_binding','principals','grants','sessions','module_modes')").all();
            wasUninitialized = priorMigrations.length === 0 && priorAccessTables.length === 0;
            this.store.migrate([{ version: 1, sql: `
      CREATE TABLE instance_binding(product TEXT NOT NULL,instance TEXT NOT NULL);
      CREATE TABLE principals(id TEXT PRIMARY KEY, kind TEXT NOT NULL, credential TEXT NOT NULL, salt TEXT NOT NULL, active INTEGER NOT NULL);
      CREATE TABLE grants(principal TEXT NOT NULL, tenant TEXT NOT NULL, permission TEXT NOT NULL, PRIMARY KEY(principal,tenant,permission));
      CREATE TABLE sessions(token_hash TEXT PRIMARY KEY, principal TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE module_modes(tenant TEXT NOT NULL,module TEXT NOT NULL,mode TEXT NOT NULL,PRIMARY KEY(tenant,module));
    ` }], { readMin: 1, readMax: 1, current: 1 });
            let allowSeed = false;
            this.store.transaction(() => {
                const rows = this.store.db.prepare('SELECT product,instance FROM instance_binding').all() as {
                product: string;
                instance: string;
                }[];
                if (rows.length > 1)
                    throw new PlatformError('INCOMPATIBLE', 'Data directory has an ambiguous local identity binding');
                const row = rows[0];
                if (row) {
                    if (row.product !== scope.productId || row.instance !== scope.instanceId)
                        throw new PlatformError('INCOMPATIBLE', 'Data directory is bound to another product instance');
                } else {
                    if (!wasUninitialized)
                        throw new PlatformError('INCOMPATIBLE', 'Existing local access storage has no identity binding and requires repair');
                    this.store.db.prepare('INSERT INTO instance_binding VALUES(?,?)').run(scope.productId, scope.instanceId);
                    if (initialPrincipals !== undefined)
                        this.insertSeeds(initialPrincipals);
                    else
                        allowSeed = true;
                }
            });
            this.seedAvailable = allowSeed;
        } catch (error) {
            this.store.close();
            throw error;
        }
    }
    seed(seeds: readonly PrincipalSeed[]) {
        if (!this.seedAvailable)
            throw new PlatformError('INCOMPATIBLE', 'Local access seeding is available only once on a newly initialized owner');
        this.seedAvailable = false;
        this.store.transaction(() => this.insertSeeds(seeds));
    }
    private insertSeeds(seeds: readonly PrincipalSeed[]) {
        for (const p of seeds) {
            if (this.store.db.prepare('SELECT id FROM principals WHERE id=?').get(p.id))
                continue;
            const service = Boolean(p.serviceToken);
            if (!service && (!p.password || p.password.length < 12))
                throw new PlatformError('INVALID', 'Local password must have at least 12 characters');
            const salt = randomBytes(16).toString('hex'), credential = service ? digest(p.serviceToken!) : scryptSync(p.password!, salt, 32).toString('hex');
            this.store.db.prepare('INSERT INTO principals VALUES(?,?,?,?,1)').run(p.id, service ? 'service' : 'user', credential, salt);
            for (const g of p.grants)
                for (const permission of g.permissions)
                    this.store.db.prepare('INSERT INTO grants VALUES(?,?,?)').run(p.id, g.tenantId, permission);
        }
    }
    login(name: string, password: string): {
        token: string;
        actor: Actor;
    } {
        const row = this.store.db.prepare(`SELECT * FROM principals WHERE id=? AND kind='user' AND active=1`).get(name) as {
            id: string;
            salt: string;
            credential: string;
        } | undefined;
        const candidate = scryptSync(password, row?.salt ?? 'unknown-principal-dummy-salt', 32);
        const expected = Buffer.from(row?.credential ?? '0'.repeat(64), 'hex');
        if (!row || !timingSafeEqual(candidate, expected))
            throw new PlatformError('UNAUTHENTICATED', 'Sign-in failed');
        const token = randomBytes(32).toString('base64url');
        this.store.db.prepare('DELETE FROM sessions WHERE expires<=?').run(this.clock());
        this.store.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(digest(token), row.id, this.clock() + 60 * 60 * 1000);
        return { token, actor: { id: row.id, kind: 'user' } };
    }
    authenticate(session?: string, bearer?: string): Actor {
        if (bearer) {
            const row = this.store.db.prepare(`SELECT id FROM principals WHERE kind='service' AND credential=? AND active=1`).get(digest(bearer)) as {
                id: string;
            } | undefined;
            if (!row)
                throw new PlatformError('UNAUTHENTICATED', 'Invalid service identity');
            return { id: row.id, kind: 'service' };
        }
        if (!session)
            throw new PlatformError('UNAUTHENTICATED', 'Sign-in required');
        const row = this.store.db.prepare(`SELECT p.id FROM sessions s JOIN principals p ON p.id=s.principal WHERE s.token_hash=? AND s.expires>? AND p.active=1 AND p.kind='user'`).get(digest(session), this.clock()) as {
            id: string;
        } | undefined;
        if (!row)
            throw new PlatformError('UNAUTHENTICATED', 'Session expired');
        return { id: row.id, kind: 'user' };
    }
    logout(token: string) { this.store.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(digest(token)); }
    tenants(actor: Actor): string[] {
        return (this.store.db.prepare('SELECT DISTINCT tenant FROM grants WHERE principal=? ORDER BY tenant').all(actor.id) as unknown as {
            tenant: string;
        }[]).map(r => r.tenant);
    }
    permissions(actor: Actor, tenant: string): string[] {
        return (this.store.db.prepare(`SELECT g.permission FROM grants g JOIN principals p ON p.id=g.principal WHERE g.principal=? AND g.tenant=? AND p.active=1 AND p.kind=? ORDER BY g.permission`).all(actor.id, tenant, actor.kind) as unknown as {
            permission: string;
        }[]).map(r => r.permission);
    }
    assert(actor: Actor, tenant: string, permission: string) {
        if (!this.permissions(actor, tenant).includes(permission))
            throw new PlatformError('DENIED', 'Operation is not permitted in this scope');
    }
    mode(tenant: string, module: string): Mode {
        return (this.store.db.prepare('SELECT mode FROM module_modes WHERE tenant=? AND module=?').get(tenant, module) as {
            mode: Mode;
        } | undefined)?.mode ?? 'enabled';
    }
    setMode(actor: Actor, tenant: string, module: string, mode: Mode) { this.assert(actor, tenant, 'platform.modules.manage'); this.store.db.prepare('INSERT INTO module_modes VALUES(?,?,?) ON CONFLICT(tenant,module) DO UPDATE SET mode=excluded.mode').run(tenant, module, mode); }
    assertModule(actor: Actor, tenant: string, module: string, permission: string, kind: 'read' | 'write') {
        this.assert(actor, tenant, permission);
        const mode = this.mode(tenant, module);
        if (mode === 'off' || (mode === 'read-only' && kind === 'write'))
            throw new PlatformError('DISABLED', 'Capability does not permit this operation');
    }
    revoke(actorId: string, tenant: string, permission: string) { this.store.db.prepare('DELETE FROM grants WHERE principal=? AND tenant=? AND permission=?').run(actorId, tenant, permission); }
    close() { this.store.close(); }
}
