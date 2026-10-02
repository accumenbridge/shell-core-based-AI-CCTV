# Product families

Product families are small, reviewed business-choice maps over the maintained module catalogue. They help a product author choose a useful starting composition; they do not define permissions, tenant modes, customer records or a separate runtime type.

The Service Operations family offers three selections:

| Choice | Source composition | What it adds |
| --- | --- | --- |
| Requests | Service Desk | Persisted service requests and explicit close actions |
| Requests + Shared library | Service Desk and Knowledge | A separately indexed document library |
| Requests + Shared library + Document handoff | Service Desk, Knowledge and Handoff | Reviewed local document-to-request handoff with a destination-owned receipt |

The reviewed family data lives at `families/service-operations/family.json`. `@quadbridge/composition/family` validates the bounded data and derives a normal `ProductDefinition` using the canonical Studio composer and resolver. Module versions, dependency rules, ports and adapters come from current source manifests and reviewed solutions. The full option explicitly chooses both reviewed local Handoff ports. The family never grants the permissions that the selected modules declare.

Paired Studio re-derives a submitted family choice from the current source before saving. The exact immutable product version and its family selection are recorded together in the existing product-version audit. A normal edit/save creates an ordinary version without a family claim; an existing version's provenance is never rewritten. The offline visual composer uses the same compiled pure derivation code for preview and export only. It cannot write source, access local files, build, or launch an application.

These choices describe source composition. They do not claim a build, registered artifact, promoted release or running instance. Each state must be established through its existing owner and exact version.
