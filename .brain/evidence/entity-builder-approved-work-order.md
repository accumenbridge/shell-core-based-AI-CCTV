# ENTITY-BUILDER-001 bounded new-owner source generator — proposal only

Prepared by /root/repo_brain_architect (Sol/high),2026-10-02. FAMILY-001 is still implementing under sole Luna ownership; EXTENSION-001 is only a proposal. This file is not task adoption, permission, an implementation or test result. No maintained source/shared Brain/build/test/runtime/browser changes were made. Reinspect accepted prior source and governing checkpoint/atlas before adoption.

## Concrete working base and missing behavior

Current factory create-module atomically refuses existing filenames and emits a real one-field title/items module with owner migration, list/create HTTP and whole-workspace UI. Factory create-product delegates to composeDraft/source catalogue; assemble uses exact selected workspace dependency closure, fixed runtime catalog and selected frontend assets. Existing tests compile a private generated checklist, persist a record and show maintained BackendHost unchanged. This is working scaffolding, not a general entity builder.

SqliteOwner already owns migration digests, transaction after-BEGIN permission checks, scoped command payload receipts/audit and no-await transaction callbacks. Service Desk close supplies the existing read-row/version/conflict pattern. CAPABILITY-001 adds strict bounded operation descriptors tied to exact selected handlers. client-core/web-shell already give reviewed workspace code accepted scope, declared owner APIs, cancellation/generation and disposal; DOM helpers safely render text.

Missing: closed entity specification/constraints/default normalization; generated owner fields/schema/operation contracts, edit/detail/optimistic version semantics and a generated form/list/detail view. Initial generator needs no maintained host or new neutral universal domain repository. The current whole Workspace ABI is sufficient; do not assume or require the unimplemented slot API. Optional generated slot contributions can be a later additive capability after their actual acceptance.

## CLI, specification and finite input profile

Add factory generate-entity <spec-file>, delegating to tools/entity-builder.mjs. Preserve create-module's existing working checklist behavior/templates. Add an optional --version value to create-product so independently named products can receive distinct validated exact versions, otherwise preserve its current default. No paired filesystem-generation endpoint or offline write/build privilege in this increment. The CLI reads one explicitly supplied bounded JSON source file; no network/command/import expression is accepted from it.

Spec schema quadbridge.entity-spec.v1 contains module {id,version,label}, entity {id,label,displayField}, and fields array. Field entries contain id,label,type,required; optional default; text minLength/maxLength, integer minimum/maximum, enum values. Boolean has only boolean default; enum default must be in the declared set. Unsupported keys/types/relationships/formulas are explicit INVALID errors. Generator validates before creating output.

Suggested exact first profile: spec64KiB UTF8;1entity;1–12fields; field ID[a-z][A-Za-z0-9_]{0,31} (safe camelCase permitted); safe lower module/route IDs compatible with existing factory; simple exact semantic versions; labels120characters; text maxLength1–4000 with total text maxima≤8000characters; safe integer range bounded to±1000000000; enums1–16 distinct strings of1–80characters. Reject duplicate/case-colliding fields by ASCII case-folded comparison, and reject reserved internal/auth names id,tenant,version,created,updated,constructor,prototype,__proto__ using that same case-folded comparison. Accepted field IDs retain their exact case. displayField must identify a required/defaulted nonempty text or enum with≤200characters. These bounds keep get/create/edit DTOs below the existing128KiB output profile and100 short list items within it; do not rely on a postcommit output-size failure. No decimals/currency/date/relation/attachment/secret-field/approval semantics are inferred.

Normalize defaults/requiredness consistently: absent field with explicit default receives that default; absent required field without default rejects; absent optional field without default is omitted in public JSON and stored SQLNULL. Explicit null is unsupported. No coercion of string numbers/boolean values. Text policy is explicit bounded trimmed text; original raw schema length plus normalized nonempty/required checks are both applied. Edit is a complete replacement of fields with the same rules, not a patch/merge language. Never silently write undefined as NULL or emit unsupported JSON-schema default/null keywords.

## Generated owner source, contracts and transactions

Generate ordinary inspectable TypeScript, module.json/package/tsconfig, literal owner migration version1 with reader/current envelope1, README, captured entity-spec.json and generation.json source receipt. Store entity columns in that module's own SQLite database with tenant/id composite key and integer record version. SQL identifiers originate only from validated closed IDs and are double-quoted by the generator (with standard identifier quote escaping); values bind through prepared statements. Generated property keys and indexed field references use JSON-escaped string literals, not raw source interpolation. Emit typed interface/projection and fixed field validation from the spec; do not introduce an all-domain runtime registry or interpret arbitrary entity input at request time. Boolean SQL0/1 must project to JSONboolean; omitted optional fields remain omitted, including during replay.

Four operation descriptors/actual handlers version1: <module>.<entity>.list/get/create/edit. Permissions <module>.read/read and <module>.write/write are declarations; actual actor grants/mode come from canonical local access and trusted ctx. Four fixed HTTP routes reuse those exact owner functions: GET /api/<module> list; GET /api/<module>/record?id=... get; POST /api/<module> create; POST /api/<module>/edit edit. Descriptor registration/parity goes through the accepted host. No new route dispatcher or public read of database paths.

List returns at most100{id,version,label} records with explicit RETURNED_ROWS_ONLY/limit indication. Detail returns{id,version,fields} with exact current tenant projection. No receipt table, audit, job internals, path or credentials are exposed. Input schema contains only entity values; never actor/product/instance/tenant/grant authority.

Create and edit use module-owned store.command with stable required command IDs, normalized payload, initiatingctx permission and synchronous transaction. Create inserts newUUID/version1. Edit captures{id,expectedVersion,fields}; inside the after-BEGIN owner transaction read exactly(ctx.tenantId,id), NOT_FOUND if absent, CONFLICT if version differs, update exactly expected version, require one changed row, return version+1. Same command/payload retries replay the original result even after later record versions; same key/different payload conflicts. HTTP/operation paths share the same operation string/key/payload normalization. No await inside a transaction and no compensating delete on a late denied response. Validate constructed bounded DTOs before mutation/receipt commit so schema failures do not unexpectedly commit malformed output.

Generated register creates one SqliteOwner for env.dataPath/env.manifest.id; if migration/registration fails before returning the owner, close the actual created handle and propagate. No cross-owner connection, universal SQL table service, grant resolver or implicit identity seeding. Existing managed/legacy initialization controls stay unchanged.

## Generated usable workspace

Generate a named workspace export using current WorkspaceContext and web-shell/dom helpers: honest loading/empty/error/read-only states, bounded list and selected detail, create form, edit form with captured expectedVersion, clearly surfaced conflict plus explicit reload. Field widgets are text/textarea, integer input, checkbox and enum select; defaults and labels derive from the same normalized spec, not a second schema. Render data with DOM textContent helpers, not raw HTML.

All reads/writes use the owner-scoped existing ctx.api. Only declared read/write permissions show controls; server validation still owns correctness. Explicit generated command ID is captured for a submitted normalized payload and retained for a same-payload retry; do not rely on ctx.api.post's fresh UUID default for an ambiguous retry. On changed draft use a new deliberate intent/key, without claiming the earlier request never committed. Cancellation and current workspace signal suppress late detail/load/notice updates; capture a detail-selection generation for out-of-order responses. Disposal removes generated listeners/timers and never retains a stale tenant view. No background polling is required by these record modules.

Emit a small module-owned declared ui/entity.css using the existing selected browserAssets mechanism; both generated modules get their own asset path. Existing literal import/static frontend closure assembles them without host branches. Optional slot metadata is not emitted unless that separate API is actually accepted/reinspected; whole-workspace acceptance is enough.

## New destinations and generation provenance

Reserve only modules/<validated-id> by exclusive mkdir after physical parent containment checks; all output writes use wx. Refuse an existing directory/file/link even if empty; never overwrite/regenerate custom code. Render/validate all bounded source contents before reservation; escape labels/defaults/enums as JSON/string literals, never raw source substitutions from user values. Keep the old create-module command unchanged. If writing fails, report incomplete source clearly; never advertise a generated result or silently fill an existing destination later. No regeneration/data migration/automatic repair contract is included.

Generation receipt identifies normalized spec digest, generator/template hashes, exact selected neutral package versions and output file hashes (excluding the receipt itself to avoid recursion). It is provenance, not executable authority or a runtime implemented flag. Module/package version is the explicit spec version; read neutral dependency versions from actual reviewed manifests, not unrelated current module pins. Existing build discovers the generated source, resolves normal manifests, and produces the fixed catalogue. Before claiming usable generation, build and actual consumer tests must pass without editing emitted source.

Generate the two proof modules/products in one test-owned privately copied source root, not as hardcoded maintained host branches. Source fixtures under examples/entities are reviewed blueprints, not already deployed products. Source generation creates ordinary modules/products before their normal canonical build/artifact admission; root contract should expressly authorize those fixed private destinations, not a blanket module-directory edit grant. Every generated output's hash is captured before/after proof. Maintain the actual framework source fingerprint separately from generated product/artifact identity.

## Two differently shaped proofs

Asset Register module asset-register@1.0.0: assetCode required text(max64/display), serviceInterval integer required(default12,min0,max120), active boolean required(defaulttrue), condition enum required(defaultin-service;in-service,repair,retired). Product maintenance-assets@1.0.0 selects only that generated module.

Room Inspection module room-inspection@0.1.0: room required text(max80/display), notes optional text(max1000), score required integer(min0,max5), passed required boolean(defaultfalse), category enum(default routine;routine,follow-up). Product site-inspections@2.1.0 selects only its generated module. The same generator must handle different names, field counts/defaults/requiredness and constraints; no named-asset or room code branches.

## Finite proposed source owner manifest (13 paths)

- apps/control-plane/src/build-inputs.ts
- tools/factory.mjs
- tools/entity-builder.mjs (new)
- templates/entity-backend.ts.txt (new)
- templates/entity-ui.ts.txt (new)
- templates/entity.css.txt (new)
- examples/entities/asset-register.json (new)
- examples/entities/room-inspection.json (new)
- docs/ENTITY_BUILDER.md (new)
- README.md
- docs/STATUS.md
- tests/entity-builder.test.mjs (new)
- tests/entity-builder-ui.test.mjs (new)

Four existing owners (factory, reviewed build-input copy policy and two user-facing entry/status documents), nine new generator/template/blueprint/docs/consumer-test paths. No maintained packages, runtime implementation, client/shell, SQLite/local-access, native helper, current domain, factory legacy templates, package installation/lock or other application-source changes are proposed. Existing factory-lifecycle/npm tests cover compatibility unchanged. If a real unsupported owner seam appears after prior-task acceptance, report it and amend finite scope before editing; do not silently add UI-slot assumptions or broad neutral entity infrastructure. Newly created source files must enter the candidate manifest before qualifying runs.

## Minimum actual recipes and acceptance

1. Fresh framework build before entity-builder-focused. A small pure spec table checks unsupported type/key, invalid default/range, unsafe duplicate identifier and occupied destination refusal. No exhaustive field permutation campaign. Assert existing create-module behavior remains available via unchanged full suite.
2. One private copy: generate both from reviewed specs, create independently versioned products via normal composer, compile/link once after generation and save exact generated source/maintained-host hashes. No manual generated-source repairs. Build/export/register/promote both normal immutable products sequentially under the unchanged single-slot original-owner profile.
3. Independent consumer tests—not generated tests alone—call both actual exported owner HTTP and operation handlers: create/default normalization, HTTP-operation same receipt replay, tenantB absent, viewer/revoked/read-only write refusal, forged/range input denial, edit1→2, same edit key replay and stale different-key CONFLICT with no overwrite. Keep these checks handful core assertions shared across two cases. Real SQLite persistence must survive same-identity restart; no new seed grants make a revoked fixture pass.
4. Physical exports omit the other generated module and its UI/CSS assets and do not require checkout/compiler. Confirm independent product/module/version/artifact/data identities. Snapshot inspection remains based on captured manifests. No changes to current immutable data for older products.
5. Required ordinary browser on each exact promoted product: create mixed-type fields, read list/detail, edit, see version/conflict handling, stop/restart and retain records. For Asset product also execute existing stopped backup→verify→existing-root refusal→test-owned absent-root restore→same identity restart and retained fields. This is the existing recovery mechanism, not a new migration adapter. Root captures native original closure, exact artifact/profile IDs and sanitized DOM/screenshots without secrets. A block stays BLOCKED and cannot be replaced by UI VM simulations to accept the full journey; no blocked file-import workaround is needed.
6. Required fresh build/freeze, complete ordinary npm test original close exit0, zero failures/cancellation/TODO and only named justified unavailable coverage; independent exact source and generated artifact/proof review. Proposed recipes brain-build, entity-builder-focused, entity-builder-browser; full suite required observation with explicit exit0 final-review gate. All generated framework/browser integration gets actual execution rather than an implemented metadata flag.

Generated UI VM checks are supporting compiled component evidence, not browser acceptance. Use tests/entity-builder-ui.test.mjs for field rendering and captured-version/command-key behavior through generated compiled UI; do not copy the whole generator logic into expected test code. Test declarations/source recipes alone do not prove persistence.

## Explicit scope limits and adoption reinspection

No relations, decimal/financial rules, date/time semantics, approval/state machine, attachment/search/index worker, destructive delete, regeneration/upgrade/existing-data evolution, universal domain repository, fleet capacity, paired/offline filesystem generation, marketplace, provider/native device or hosted/customer production. This does not implement complete ERP/CCTV products. Distinct product requirements still drive later modules. Native closure/ownership and original-session security stay inherited, not weakened for a demonstration.

Before adoption inspect actual FAMILY acceptance and any accepted UI-slot contracts; resolve current source drift/task focus in Brain/atlas, then pin actual generator/owner/build/closure/runtime/recovery. The whole Workspace path exists now, so UI slots are not a technical prerequisite unless root elects that later explicit demonstration. No architecture promise is inferred from .local/ui-slots-plan.md.

## Inspected source hashes (planning snapshot only)

- tools/factory.mjs: fc1e8b8bb0953216bb61df7b31893d3be23319f733fd02cb5fee8af2f281f62c
- templates/module-backend.ts.txt: 54826a7c489967e5aca7175e31addc67435a0f522600212ac65b7b16f5e1359c
- templates/module-ui.ts.txt: f077a9c63960778c0559eb71bae4389a825163f6b89e2b575d88e6ac50ac3202
- packages/sqlite/src/index.ts: 03fb605c558044e72002d3787b7b7b974de3850597fb06852e07883c3d7d1e08
- packages/contracts/src/index.ts: 852c500432771ca76f0c6377281588c6a918d5cc57096e8c63684a110302c1ed
- packages/contracts/src/operations.ts: 8666d65dceac6667b18d5cec252beb758106eb296aef8c09e925fa052764e765
- packages/module-sdk/src/index.ts: 1ef11c3b32550b1df3bc9330201d1547dc0af65a1d544a7d9a0851965c66d26a
- packages/web-shell/src/dom.ts: 14dfeecc630f1b229ae487ce209756df91a4610b6a4ad11500ff7af30af50920
- packages/client-core/src/index.ts: f2b8521725db0f06934ac59ccb0139cd82eea608805457bc8e33f0122d863c5e
- packages/web-shell/src/index.ts: db0186cc8ee7f8b192b7df15172e60bd4df95017ef3c88a56129a230ac1a4d0c
- modules/service-desk/src/index.ts: a013d0e6034fca24434e54b6096d748127fabfe6a414b822d91c8954afc2d69c
- tools/build.mjs: d08713084bb96166cbd3140285735aba7293c4c69719f3988e6689d79de05b27
- tools/frontend-closure.mjs: e9a264807c8ae6793d71adb1aec1f6cbd282cd6618b35f652cffd60296db5387
- tools/product-source.mjs: d3a7d465f2c32f82329936dcaeb041cfde85bd536019a59aa7c754531909a8f2
- tools/runtime-recovery.mjs: 8fd0981ee90b31673e4487a2de72b4dd6918d8b16abab1dea8131885a364cf35
- apps/control-plane/src/runtime-recovery.ts: 02f9fdb51c5cbfac1a12d92ae19e861fdc3ee03626a462979b8a31bea90e3f1d
- tests/factory-lifecycle.test.mjs: fa633365340a112b07a4951895dc840bcc437a19920e918008445feca37bba25
- docs/plans/SPLE_FAST_PRODUCT_BUILDER_PLAN.md: c5c3bc76040a5d6c9564b26fc150b7135422ee3dc74b7a66a6fd778ceeb78bc3
- .brain/evidence/framework-next-core-plan.md: 10b526409bd551564e65b9340d5a1e1cbd6c15a4e66ae4aca7c2c5fde8365e52

## Revised planning amendment 01 — exact generator/source receipt copy closure

Prepared 2026-10-02T08:07:20.208Z by /root/repo_brain_architect. Original proposal .local/entity-builder-plan.md SHA256 de34b196993c6a5aa3cd2f10a2f430559a1e8e69ce1d490e30d1f66a3f3f0bb0 is preserved unchanged. Current inspected apps/control-plane/src/build-inputs.ts SHA256 cb5cb5ac95f0e4ea8dfac74847ea26ac3c2c4bae5449302a1a0e2dadaf6c0528; future adoption must reinspect accepted FAMILY/UI-slot source, not reuse this planning hash as execution readiness.

Confirmed concrete gaps: TOOL_FILES omits entity-builder.mjs, so the fixed private copy silently omits that tool; TEMPLATE_FILES omits entity-backend.ts.txt/entity-ui.ts.txt/entity.css.txt, so those new source templates reject reviewed copying; module-root rule currently accepts only module.json/package.json/tsconfig.json, so generated entity-spec.json/generation.json/README.md reject the normal build worker's reviewed source closure. This is an ordinary actual generate→build pipeline defect in the original proposal, not a reason to broaden all JSON/text acceptance. Add only this one maintained owner, making the finite manifest11.

Exact rule amendments: add tools/entity-builder.mjs to TOOL_FILES; add the three exact named templates to TEMPLATE_FILES; under modules/<existing-safe-module-id> at depth3 accept only entity-spec.json, generation.json and README.md in addition to the current metadata files. These are inert captured source/receipt/documentation, not grants, runtime schema interpreters or dynamic import instructions. Preserve all existing physical regular-file/no-link containment, SECRET/PORTABLE/EXCLUDED and copied-set hash verification rules. Do not allow arbitrary module-root JSON/Markdown, subdirectories or developer data. Generator validates its closed spec before output and emits a bounded normalized spec and receipt plus short README; receipt output hashes exclude itself. No user path is interpreted from the receipt.

Existing reviewedBuildFiles/sourceFingerprint/copyReviewedBuildInputs includes these exact files, binding their bytes to the generated product's frozen pre-overlay identity. Keep the receipt and schema source at the proposed generated module root rather than relocating them into an executable authority or excluded operational folder. Existing factory selected-module copy then carries the files as inert selected source in its regular export; exact exported inventory still controls integrity. No new factory packaging/fingerprint algorithm or custom runtime branch is needed. Framework source candidate identity remains separate from generated product source identity.

The maintained examples/entities blueprints remain explicitly supplied fixed CLI inputs in the consumer fixture (read from the inspected source or copied explicitly by the test); this amendment does not add examples/ wholesale to build ROOTS. The tool receives one bounded spec and emits its normalized captured entity-spec.json before product admission. Keep FAMILY's family.json rule and future reviewed solution/ui.json rule intact, without coupling generation to a family name.

Minimum useful check, in already proposed tests/entity-builder.test.mjs: generate both actual modules in one private copied checkout, assert exact generator/templates and each selected metadata file participate in reviewedBuildFiles, then use the existing worker admission/copy path to build their ordinary products. Assert changing a captured entity-spec/receipt byte changes source identity; adjacent unreviewed metadata still rejects. This belongs in the same core generated artifact journey, not a new stress/adversarial matrix or additional source owner. No build/test/runtime/browser was invoked to prepare this amendment.

## Revised planning amendment 02 — complete fixed CLI closure, short fixture and core docs

Prepared 2026-10-02T09:02:18.397Z by /root/repo_brain_architect. Planning only; EXTENSION-001 is active. No maintained/shared Brain/check/runtime/browser mutations. Original and revised01 remain unchanged; revised01 SHA256 6606ae17af93fcd6e53db794a3f33fd5525eb5119ff1622dde103e53bdd33bfd. Final proposed owner total is13, superseding the historical11 totals in amendment01. Future admission requires accepted UI source/current task reinspection.

Confirmed factory create-product imports './product-source.mjs'. That existing fixed helper reads canonical catalogue/validates the product, checks its physical products parent, reserves a new directory with mkdir and writes product.json using wx. TOOL_FILES currently lacks product-source.mjs, so reviewed copying silently omits the .mjs helper and the planned normal create-product invocation in its private source root fails MODULE_NOT_FOUND. Add only the exact product-source.mjs leaf to TOOL_FILES within already-owned apps/control-plane/src/build-inputs.ts, alongside revised01's exact entity tool/templates/receipt entries. No product-source helper edit, dynamic resolver, broad tool/JSON allowance or alternate composition algorithm. The existing real generate→create-product→build consumer journey checks this fixed dependency by actual execution; no added test matrix.

Keep maintenance-assets@1.0.0 and site-inspections@2.1.0 identities. Use a short directly owned mkdtemp source root, e.g. tmpdir()/qe-<random>, without a redundant checkout child. Contain control DB/private metadata there too. Check actual generated inventory and projected worker/runtime paths through unchanged preflights before admission; where native/runtime guards reject length>=240, require strictly below240. The observed Family250-path refusal motivates shorter fixture nesting only, not a production bound change, different identities or silently omitted files. Preserve positive original-owned cleanup/uncertainty retention.

Add only README.md/docs/STATUS.md as final user-facing documentation owners, already present in the existing232 fingerprint. Update concise practical family selection, trusted same-origin UI panels and entity generation/product commands using actual current source versions/profile. Preserve actual evidence versus unqualified browser/device/provider/hosted/production and named coverage limits; no final hash/count/passing claim before the runs. Finish this doc pass alongside docs/ENTITY_BUILDER.md before final freeze/build/full checks to avoid a separately stale release; no broader architecture/editorial changes.

Finite13 consists of2 existing code owners(factory/build-inputs),2 existing docs(README/status) and9 already proposed new generator/template/blueprint/doc/test paths. No other framework/runtime/domain/grant/schema/native/security/lock/external source owners. Expected larger candidate241 is root's planning total232+9, not verified physical evidence or extra edit authority. User-authorized eventual commit/push is root-coordinated after core qualification, not credential/deployment/global-setting authority.

Exact narrow inspected hashes:
- tools/factory.mjs: fc1e8b8bb0953216bb61df7b31893d3be23319f733fd02cb5fee8af2f281f62c
- tools/product-source.mjs: d3a7d465f2c32f82329936dcaeb041cfde85bd536019a59aa7c754531909a8f2
- apps/control-plane/src/build-inputs.ts: aa43159e1f688abfdbd99ed8c8abe171a251e863f7e77e55a68fc769e8e2a423
- README.md: d641e2e0076e81b8a7fdd298ccf1f8c4a2162d260e07163823c1d0db97948aa0
- docs/STATUS.md: 2736780521c1015a2b232f26f9ea2c5633bb455853360a0b81e738b3cccde133

## Revision03 — consistent camelCase field identity

Prepared 2026-10-02T09:24:24.126Z by /root/repo_brain_architect (Sol/high), planning only. All earlier proposals remain untouched. The prior lowercase-only field profile contradicted the accepted Asset Register blueprint assetCode/serviceInterval. This revision explicitly allows ^[a-z][A-Za-z0-9_]{0,31}$, retaining those intended field identities. It does not extend module/route ID grammar. Case-folding is solely a validation comparison for collisions and reserved names; it must never rename a field. Validate all field IDs and displayField identity before output, quote the validated SQL identifiers, and JSON-escape generated TypeScript/JavaScript field keys/references.

The normalized entity-spec.json and generation receipt digest retain exactly the accepted field ID spelling and declared array order, including displayField. Any documented value/default normalization is applied consistently, but no implicit field rename, lowercase conversion, alias, or schema migration is permitted. Output DTO fields and commands use those exact IDs. The ordinary two-blueprint proof already covers camelCase and differing field shapes; keep the existing small invalid identifier/case-collision check, not a new matrix.

Finite owner manifest remains exactly13 paths; fixed product-source/tool/template copy amendment and short private fixture below unchanged240-character profile remain intact. No source, Brain, build, test or runtime mutation and no current delivery acceptance. Actual accepted prior-source reinspection remains mandatory before adoption.
