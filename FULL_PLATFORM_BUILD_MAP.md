# Full Product Studio build map

The platform is being implemented as one continuous system. Each phase extends the same contracts and control plane; later phases do not replace earlier ones.

| Phase | Deliverable | UI | Backend | AI | Data/Infra | Status |
|---|---|---:|---:|---:|---:|---|
| 0.2 | composition/runtime kernel | yes | yes | no | local SQLite/runtime | retained |
| 0.3 | whole-platform kernel | yes | yes | planner/contracts | control-plane SQLite + deployment contracts | implemented |
| 0.4 | artifact/build plane | build/release UI | isolated builder API | model artifact declarations | S3/MinIO registry | next |
| 0.5 | deployment plane | env/deploy UI | controller + agents | model deployment hooks | cloud/edge drivers + secrets | next |
| 0.6 | visual product construction | drag/drop UI/backend/data wiring | graph compiler | visual AI DAG editor | schema/infra editor | next |
| 0.7 | production identity/operations | org/admin UI | OIDC/RBAC/audit | AI usage policy | logs/metrics/traces | next |
| 1.0 | production release platform | complete | complete | provider/model serving adapters | signed promotion/rollback | target |

## Non-negotiable architecture rule

A large future module is one versioned vertical slice. It may contribute UI, backend services, events/jobs, AI pipelines, data ownership and deployment requirements, but Product Studio still uses one module registry and one composition authority.
