/** Source-grounded business feature derivation over the canonical Studio composer. */
import type { CompositionPlan, ModuleManifest, ProductDefinition } from '@quadbridge/contracts';
import { resolve } from './index.js';
import { composeDraft, validateProduct, type StudioSolution } from './studio.js';

export interface ProductFamilyFeature {
  id: string;
  label: string;
  description: string;
  moduleIds: string[];
  requires?: string[];
  bindingChoices?: Record<string, string>;
}
export interface ProductFamily {
  schema: 'quadbridge.product-family.v1';
  id: string;
  version: string;
  title: string;
  description: string;
  requiredFeatureIds: string[];
  defaultFeatureIds: string[];
  features: ProductFamilyFeature[];
}
export interface FamilyProductIdentity {
  id: string;
  title: string;
  version: string;
  description: string;
  layout: 'sidebar' | 'top';
}
export interface FamilyReason { featureId: string; label: string; reason: string; moduleIds: string[] }
export interface FamilyDerivation {
  schema: 'quadbridge.family-derivation.v1';
  familyId: string;
  familyVersion: string;
  selection: string[];
  moduleVersions: { id: string; version: string }[];
  bindingChoices: { key: string; choiceId: string }[];
  reasons: FamilyReason[];
}
export interface FamilyDerivationResult {
  product: ProductDefinition;
  plan: CompositionPlan;
  reasons: FamilyReason[];
  technicalExplanations: { moduleId: string; reason: string; requested: boolean }[];
  requirements: { consumer: string; contract: string; choice: string; label: string; mode: string; prerequisites: string[] }[];
  derivation: FamilyDerivation;
}

function fail(code: string, message: string): never { throw Object.assign(new Error(message), { code }); }
const safeId = (value: unknown): value is string => typeof value === 'string' && /^[a-z][a-z0-9-]{1,47}$/.test(value);
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function stringList(value: unknown, label: string, limit: number): string[] {
  if (!Array.isArray(value) || value.length > limit || value.some(item => !safeId(item)) || new Set(value).size !== value.length)
    fail('FAMILY_INVALID', `${label} must be a bounded list of unique IDs.`);
  return (value as unknown[]).slice() as string[];
}

/** Validate the reviewed family data as bounded inert data before using it. */
export function validateProductFamily(value: unknown): ProductFamily {
  if (!record(value)) fail('FAMILY_INVALID', 'Reviewed family data has an invalid bounded shape.');
  const source=value;
  const schema=source.schema,id=source.id,version=source.version,title=source.title,description=source.description,rawFeatures=source.features;
  if (Object.keys(source).some(key => !['schema','id','version','title','description','requiredFeatureIds','defaultFeatureIds','features'].includes(key)) ||
      schema !== 'quadbridge.product-family.v1' || !safeId(id) || typeof version !== 'string' || !/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(version) ||
      typeof title !== 'string' || !title.trim() || title.length > 80 || typeof description !== 'string' || description.length > 1000 ||
      !Array.isArray(rawFeatures) || rawFeatures.length < 1 || rawFeatures.length > 16)
    fail('FAMILY_INVALID', 'Reviewed family data has an invalid bounded shape.');
  const features: ProductFamilyFeature[] = [];
  const ids = new Set<string>();
  for (const item of rawFeatures as unknown[]) {
    if (!record(item)) fail('FAMILY_INVALID', 'Family features must have unique IDs and bounded text.');
    const feature=item,id=feature.id,label=feature.label,featureDescription=feature.description;
    if (Object.keys(feature).some(key => !['id','label','description','moduleIds','requires','bindingChoices'].includes(key)) ||
        !safeId(id) || ids.has(id) || typeof label !== 'string' || !label.trim() || label.length > 80 ||
        typeof featureDescription !== 'string' || featureDescription.length > 500)
      fail('FAMILY_INVALID', 'Family features must have unique IDs and bounded text.');
    ids.add(id);
    const moduleIds = stringList(feature.moduleIds, 'Feature modules', 16);
    const requires = feature.requires === undefined ? [] : stringList(feature.requires, 'Feature requirements', 16);
    let bindingChoices: Record<string, string> | undefined;
    if (feature.bindingChoices !== undefined) {
      if (!record(feature.bindingChoices) || Object.keys(feature.bindingChoices).length > 16) fail('FAMILY_INVALID', 'Feature binding choices must be a bounded object.');
      const rawChoices=feature.bindingChoices;
      bindingChoices = {};
      for (const [key, choice] of Object.entries(rawChoices)) {
        if (!/^[a-z][a-z0-9-]{1,47}:[a-z][a-z0-9.-]{0,63}$/.test(key) || !safeId(choice)) fail('FAMILY_INVALID', 'Feature binding choices must use reviewed port and choice IDs.');
        bindingChoices[key] = choice;
      }
    }
    features.push({ id, label, description: featureDescription, moduleIds, ...(requires.length ? { requires } : {}), ...(bindingChoices ? { bindingChoices } : {}) });
  }
  const requiredFeatureIds = stringList(source.requiredFeatureIds, 'Required features', 16);
  const defaultFeatureIds = stringList(source.defaultFeatureIds, 'Default features', 16);
  for (const id of [...requiredFeatureIds, ...defaultFeatureIds]) if (!ids.has(id)) fail('FAMILY_INVALID', `Family references unknown feature ${id}.`);
  for (const feature of features) for (const id of feature.requires ?? []) if (!ids.has(id)) fail('FAMILY_INVALID', `Feature ${feature.id} references unknown prerequisite ${id}.`);
  return { schema: schema as ProductFamily['schema'], id: id as string, version: version as string, title: title as string, description: description as string,
    requiredFeatureIds, defaultFeatureIds, features };
}

/** Derive an ordinary immutable ProductDefinition; module versions and adapters come only from source. */
export function deriveFamily(familyInput: unknown, selectionInput: unknown, identityInput: unknown,
  catalogue: readonly ModuleManifest[], solutions: readonly StudioSolution[]): FamilyDerivationResult {
  const family = validateProductFamily(familyInput);
  if (!record(identityInput)) fail('FAMILY_INVALID_IDENTITY', 'Provide a valid exact product identity, version and layout.');
  const identity=identityInput,identityId=identity.id,identityTitle=identity.title,identityVersion=identity.version,identityDescription=identity.description,identityLayout=identity.layout;
  if (Object.keys(identity).some(key => !['id','title','version','description','layout'].includes(key)) ||
      !safeId(identityId) || typeof identityTitle !== 'string' || !identityTitle.trim() || identityTitle.length > 80 ||
      typeof identityVersion !== 'string' || !/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(identityVersion) ||
      typeof identityDescription !== 'string' || identityDescription.length > 2000 ||
      (identityLayout !== 'sidebar' && identityLayout !== 'top'))
    fail('FAMILY_INVALID_IDENTITY', 'Provide a valid exact product identity, version and layout.');
  const selection = [...stringList(selectionInput, 'Feature selection', 16)].sort();
  const featureById = new Map(family.features.map(feature => [feature.id, feature]));
  for (const id of selection) if (!featureById.has(id)) fail('FAMILY_UNKNOWN_FEATURE', `Unknown family feature: ${id}.`);
  for (const id of family.requiredFeatureIds) if (!selection.includes(id)) fail('FAMILY_REQUIREMENT_UNMET', `Select required feature: ${featureById.get(id)!.label}.`);
  const selected = new Set(selection);
  const moduleIds = new Set<string>();
  const choices: Record<string, string> = {};
  const reasons = selection.map(id => {
    const feature = featureById.get(id)!;
    for (const prerequisite of feature.requires ?? []) if (!selected.has(prerequisite))
      fail('FAMILY_REQUIREMENT_UNMET', `${feature.label} requires ${featureById.get(prerequisite)!.label}.`);
    for (const moduleId of feature.moduleIds) moduleIds.add(moduleId);
    for (const [key, choiceId] of Object.entries(feature.bindingChoices ?? {})) {
      if (Object.hasOwn(choices, key) && choices[key] !== choiceId) fail('FAMILY_BINDING_UNAVAILABLE', `Selected features require conflicting choices for ${key}.`);
      choices[key] = choiceId;
    }
    return { featureId: id, label: feature.label, reason: feature.description, moduleIds: [...feature.moduleIds].sort() };
  });
  const selectedFeatureModules = new Set([...selected].flatMap(id => featureById.get(id)!.moduleIds));
  for (const feature of family.features) if (!selected.has(feature.id)) {
    for (const moduleId of feature.moduleIds) if (!selectedFeatureModules.has(moduleId) && moduleIds.has(moduleId))
      fail('FAMILY_IMPLEMENTATION_UNAVAILABLE', `${feature.label} is not selected, so ${moduleId} cannot be included.`);
  }
  for (const moduleId of moduleIds) if (!catalogue.some(module => module.id === moduleId))
    fail('FAMILY_IMPLEMENTATION_UNAVAILABLE', `The reviewed source catalogue does not provide ${moduleId}.`);
  let composed;
  try {
    composed = composeDraft({ id: identityId as string, title: identityTitle as string, version: identityVersion as string,
      layout: identityLayout as 'sidebar'|'top', selected: [...moduleIds].sort(), ...(Object.keys(choices).length ? { choices } : {}) }, catalogue, solutions, identityVersion as string);
  } catch (error) {
    fail('FAMILY_BINDING_UNAVAILABLE', error instanceof Error ? error.message.slice(0, 240) : 'The selected family has no reviewed implementation.');
  }
  for (const requirement of composed!.requirements) {
    const key = `${requirement.consumer}:${requirement.contract}`;
    if (!Object.hasOwn(choices, key) || choices[key] !== requirement.choice)
      fail('FAMILY_BINDING_UNAVAILABLE', `Family data must explicitly select a reviewed choice for ${key}.`);
  }
  for (const module of composed!.plan.modules) for (const feature of family.features) {
    if (!selected.has(feature.id) && !selectedFeatureModules.has(module.id) && feature.moduleIds.includes(module.id))
      fail('FAMILY_IMPLEMENTATION_UNAVAILABLE', `${feature.label} is not selected, so ${module.id} cannot be included.`);
  }
  const product = validateProduct({ ...composed!.product, description: identityDescription as string }, catalogue, solutions);
  const plan = resolve(product, catalogue);
  const moduleVersions = plan.modules.map(module => ({ id: module.id, version: module.version })).sort((a,b) => a.id.localeCompare(b.id));
  const bindingChoices = Object.entries(choices).sort(([a], [b]) => a.localeCompare(b)).map(([key, choiceId]) => ({ key, choiceId }));
  const derivation: FamilyDerivation = { schema: 'quadbridge.family-derivation.v1', familyId: family.id, familyVersion: family.version,
    selection, moduleVersions, bindingChoices, reasons };
  return { product, plan, reasons, technicalExplanations: composed!.explanation, requirements: composed!.requirements, derivation };
}
