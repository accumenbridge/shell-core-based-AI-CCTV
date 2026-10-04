/** Static Product translation for source and fixed local-inference ports. */
import { PlatformError } from '@quadbridge/contracts';

function sourceContext({ context, productId, config, consumerContext, sourceModule }) {
  return context(consumerContext.actor, consumerContext.tenantId, sourceModule, consumerContext.signal, consumerContext.requestId, consumerContext.assertOriginalAuth);
}

export async function bind({ binding, config, productId, publicService, context }) {
  if (binding.scope !== 'application' || binding.mode !== 'local')
    throw new PlatformError('INCOMPATIBLE', 'Veyviz uses fixed application-scoped local ports');
  if (binding.contract === 'veyviz.product-authority.v1' && binding.consumer === 'veyviz-intelligence' && binding.implementation === 'veyviz-sources') {
    publicService(binding.contract, binding.implementation);
    const capturedContext = (scope, requestId, signal = new AbortController().signal) => {
      if (scope.productId !== productId || scope.instanceId !== config.instanceId) throw new PlatformError('INCOMPATIBLE', 'Temporal authority scope differs from this Product instance');
      return context({ id: scope.actorId, kind: scope.actorKind }, scope.tenantId, binding.consumer, signal, requestId);
    };
    return { context: capturedContext, assert(scope, kind) {
      if (scope.productId !== productId || scope.instanceId !== config.instanceId || !['read', 'write'].includes(kind)) throw new PlatformError('INCOMPATIBLE', 'Temporal authority scope differs from this Product instance');
      const ctx = capturedContext(scope);
      ctx.assertAllowed(`veyviz.intelligence.${kind}`, kind);
    } };
  }
  if (binding.contract === 'veyviz.sources.read.v1' && binding.consumer === 'veyviz-analysis' && binding.implementation === 'veyviz-sources') {
    const source = publicService(binding.contract, binding.implementation);
    if (!source || typeof source.get !== 'function' || typeof source.list !== 'function') throw new PlatformError('INCOMPATIBLE', 'Selected source reader does not implement the declared contract');
    return {
      list(ctx) { return source.list(sourceContext({ context, productId, config, consumerContext: ctx, sourceModule: binding.implementation })); },
      get(ctx, sourceId) { return source.get(sourceContext({ context, productId, config, consumerContext: ctx, sourceModule: binding.implementation }), sourceId); },
      getForActor(identity, sourceId, signal) {
        if (identity.scope.productId !== productId || identity.scope.instanceId !== config.instanceId)
          throw new PlatformError('INCOMPATIBLE', 'Captured analysis scope differs from this Product instance');
        const actor = Object.freeze({ id: identity.scope.actorId, kind: identity.scope.actorKind });
        // Persisted jobs must reauthorize the original analysis actor against current
        // grants and module mode before every source read, including result commit.
        const writer = context(actor, identity.scope.tenantId, binding.consumer, signal, identity.requestId);
        if (writer.productId !== identity.scope.productId || writer.instanceId !== identity.scope.instanceId || writer.tenantId !== identity.scope.tenantId || writer.actor.id !== actor.id || writer.actor.kind !== actor.kind)
          throw new PlatformError('INCOMPATIBLE', 'Analysis write context does not match the original command identity');
        writer.assertAllowed('veyviz.analysis.write', 'write');
        const ctx = context(actor, identity.scope.tenantId, binding.implementation, signal, identity.requestId);
        if (ctx.productId !== identity.scope.productId || ctx.instanceId !== identity.scope.instanceId || ctx.tenantId !== identity.scope.tenantId || ctx.actor.id !== actor.id || ctx.actor.kind !== actor.kind)
          throw new PlatformError('INCOMPATIBLE', 'Source read context does not match the original analysis identity');
        return source.get(ctx, sourceId);
      }
    };
  }
  if (binding.contract === 'veyviz.sources.query.v1' && binding.consumer === 'veyviz-analysis' && binding.implementation === 'veyviz-sources') {
    const source = publicService(binding.contract, binding.implementation);
    if (!source || typeof source.query !== 'function') throw new PlatformError('INCOMPATIBLE', 'Selected source query does not implement the declared contract');
    return {
      query(ctx, request) { return source.query(sourceContext({ context, productId, config, consumerContext: ctx, sourceModule: binding.implementation }), request); }
    };
  }
  if (binding.contract === 'veyviz.recorded-analysis.run.v1' && binding.consumer === 'veyviz-analysis' && binding.implementation === 'veyviz-rfdetr') {
    const runner = publicService(binding.contract, binding.implementation);
    if (!runner || typeof runner.run !== 'function' || typeof runner.readiness !== 'function') throw new PlatformError('INCOMPATIBLE', 'Selected inference provider does not implement the declared contract');
    return runner;
  }
  throw new PlatformError('INCOMPATIBLE', `No reviewed Veyviz binding for ${binding.consumer}:${binding.contract}`);
}
