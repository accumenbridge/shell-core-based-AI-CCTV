# Bounded entity source builder

`npm run factory -- generate-entity <spec-file>` creates ordinary inspectable module source in a new `modules/<id>` directory. The specification is a bounded input to source generation; it is not executable code, a runtime registry, or permission to alter an existing module. The command refuses an occupied destination. Review and version the generated TypeScript like other module source.

The first profile is `quadbridge.entity-spec.v1`: one entity with 1–12 fields, exact module/entity IDs and versions, and only text, integer, boolean, or enum values. Text is trimmed and length-bounded, integers are safe and range-checked, booleans stay booleans, and enum values must match their declared set. Defaults are applied when a value is absent; optional fields without defaults are omitted. Unsupported keys, types, relationships, formulas, and fields fail validation. The total text field limit is 8,000 characters; each source file is written exclusively, and the normalized spec, generator, templates, package versions, and generated outputs are recorded in `generation.json`.

The generated owner has its own tenant-scoped SQLite table and migration, fixed list/get/create/edit operation descriptors and matching HTTP routes, a bounded list and record view, and optimistic version checks. Creates and edits share the same owner command receipts across HTTP and operation invocation. An edit replaces the complete field set and must include the version that was loaded. A known version conflict requires an explicit reload; an ambiguous request keeps the original payload and command key available for exact retry. Read/write controls follow the module permission granted by the actual local access store. The generator never adds grants or seeds identities.

For example, the reviewed blueprints can be used in a fresh source checkout:

```text
npm run factory -- generate-entity examples/entities/asset-register.json
npm run factory -- create-product maintenance-assets --modules asset-register --version 1.0.0
npm run build
```

The Room Inspection blueprint is independent and can be used similarly with `room-inspection` and its own product ID/version. Each generated product selects only its module and declared UI asset through the normal source-derived catalogue and build closure. A product build produces an immutable local artifact; register, promote, and runtime actions remain separate explicit controls in the paired local Studio.

This starter is intended for simple bounded records, not a universal domain interpreter. It does not infer relations, date/currency semantics, approval workflows, attachments, destructive delete, schema upgrades, or automatic regeneration. Existing module data and custom source are never overwritten. The generated workspace is ordinary module UI and owner code; actual product behavior still depends on reviewing the domain rules and testing the built product under its real access modes.
