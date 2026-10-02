# Full Product Studio build map

The platform is implemented as one continuous system. Each phase extends the same contracts and control plane; later phases do not replace earlier ones. The table separates the shipped local developer profile from future hosted/production adapters.

| Phase | Deliverable | UI | Backend | AI | Data/Infra | Status |
|---|---|---:|---:|---:|---:|---|
| 0.2 | composition/runtime kernel | yes | yes | no | local SQLite/runtime | retained |
| 0.3 | whole-platform kernel | yes | yes | planner/contracts | control-plane SQLite + deployment contracts | implemented |
| 0.4 | local artifact/build plane | paired build/artifact UI | local fixed builder and registry | model artifact declarations | local immutable snapshots | shipped local profile; remote S3/MinIO remains future |
| 0.5 | deployment admission | environment/deployment UI | durable request admission | model deployment declarations | local state only | admission is implemented; controllers/agents and cloud/edge execution remain future |
| 0.6 | source-derived product construction | offline and paired ProductDefinition editors; static module contributions | canonical composer and fixed source builders | AI planning contracts | module-owned SQLite | bounded profiles shipped; drag/drop graph editors and general schema tooling remain future |
| 0.7 | local operations | operator/runtime views | local audit and runtime ownership | local extractive Knowledge answer | local SQLite and supervised snapshots | local developer controls shipped; enterprise identity/central telemetry remain future |
| 1.0 | production release platform | complete | complete | provider/model serving adapters | signed promotion/rollback | target |

## Non-negotiable architecture rule

A large future module is one versioned vertical slice. It may contribute UI, backend services, events/jobs, AI pipelines, data ownership and deployment requirements, but Product Studio still uses one module registry and one composition authority.

Version values remain independent: repository package `0.2.0`, Product Studio program `0.3`
(`studio-web` package `0.3.0`), module/product exact SemVer, module ABI
`quadbridge.module.v1`, operation contract versions, and entity/family/UI/local-snapshot schema tags.
See [PLATFORM_ARCHITECTURE.md](PLATFORM_ARCHITECTURE.md), [docs/STATUS.md](docs/STATUS.md) and
[docs/ENTITY_BUILDER.md](docs/ENTITY_BUILDER.md) for the local scope and its recovery, upgrade and
production limits.
