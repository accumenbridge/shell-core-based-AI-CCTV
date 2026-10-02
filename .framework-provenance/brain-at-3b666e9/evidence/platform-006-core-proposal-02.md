# PLATFORM-006 core proposal

Sol/high read-only proposal refined under the user's core-delivery priority, 2026-10-01. Not adopted or implemented. Current work remains PLATFORM-005A. No CP6 provider, runtime, browser or test execution is claimed.

Usable outcome: question -> authorized indexed excerpts -> exact cited extractive answer in the Knowledge application workspace. Label it "Local extractive answer"; model inference remains unattached. Knowledge owns retrieval, documents and citation validation. Neutral ai-core owns evidence/retrieval/provider interfaces and a fixed bounded executor. No arbitrary graph/tool execution, executable URLs or provider credentials.

Add knowledge.document.retrieve.v1 while preserving read.v1, and POST /api/documents/answer with knowledge.read/read-kind. Retrieve only the current tenant's indexed READY records. Citations bind product/instance/tenant/document/version/body digest and exact excerpt ranges. Output text is constructed from validated source excerpts; indexed-only/no-evidence results are explicit. No answer database, durable job or inferred spend. UI adds question/cancel/answer/source title/version/excerpt details with stale-request fences.

Add a backward-compatible captured request-auth callback to backend-host execution/context. Revalidate the original business session and actor before consequential reads/provider dispatch and after awaits before delivery. Preserve grant/module checks in assertAllowed; no global actor map or authorization inferred from operator pairing.

Coherent single-version source update: Knowledge and Handoff manifests/packages0.2.1; Handoff exact Knowledge dependency0.2.1; Knowledge/Combined source products0.2.1 selecting those versions. Knowledge schema remains1, Handoff domain/protocol semantics remain unchanged, Desk/Neutral unchanged. Update necessary source fixtures/lockfile. Old immutable snapshots and release records stay intact; no general multi-version catalogue or automatic data adoption.

Necessary export seam: factory/integrity currently hardcode runtime dependency versions0.2.0 and omit ai-core0.3.0. Use a shared pure reviewed workspace-dependency closure seeded by fixed host packages and selected module manifests. Emit actual package/module versions; verify against captured snapshot bytes so old inventories retain their old closure. No package downloads, editable exported authority or product-name export branches. Expose a distinct lexical/extractive recipe in source/Studio metadata; legacy embedding/model declarations remain separate.

Initial bounds: question1000 characters,5 evidence records,16KiB excerpts,8KiB output,5-second deadline,4 actual in-flight provider calls. Cancellation/deadline suppress late output; retain in-flight reservation until actual provider settlement.

Minimum checks: actual indexed document -> answer/exact citations and honest no evidence; tenant/grant/module denial prevents disclosure/provider input; logout/cancellation during provider await suppresses output; existing Handoff read.v1 consumer and new-version build/export remain coherent; real application UI separately qualified. Fresh build, required npm test and exact independent review precede local acceptance. No expanded fault/stress campaign or model/production claim.
