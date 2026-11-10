import type { ExpressionNode, LambdaExpression } from '../expression/nodes.js';
import { external } from '../expression/nodes.js';
import type { QueryPlan } from './plan.js';

/**
 * Rewrites the parameter-bag identifiers a plan refers to.
 *
 * Every query numbers its own bags from zero, so combining two independently
 * built queries would otherwise merge two unrelated `p0` bags into one. The
 * joined side is renumbered past the bags the other side already holds, and its
 * plan rewritten here so each reference still points at the values it was
 * written against.
 */
export function renameBags(plan: QueryPlan, renames: ReadonlyMap<string, string>): QueryPlan {
  return renames.size === 0 ? plan : rewritePlan(plan, renames);
}

function rewritePlan(plan: QueryPlan, renames: ReadonlyMap<string, string>): QueryPlan {
  switch (plan.kind) {
    // `append`'s row is built from `constant` alone, never from the parameter
    // bag, so `literalRow` has nothing here to rewrite either; `rawSource`'s
    // own values are built the same way for the same reason.
    case 'source':
    case 'literalRow':
    case 'rawSource':
      return plan;

    case 'while':
    case 'where':
    case 'wherePosition':
      return {
        ...plan,
        source: rewritePlan(plan.source, renames),
        predicate: rewriteLambda(plan.predicate, renames),
      };

    // `rank` is among these for `index`'s reason: its `dense` is a plain
    // boolean rather than a bag reference, so the projector is the whole of
    // what it has to rewrite.
    case 'select':
    case 'pairwise':
    case 'index':
    case 'rank':
      return {
        ...plan,
        source: rewritePlan(plan.source, renames),
        projector: rewriteLambda(plan.projector, renames),
      };

    // The framed operators are apart from the group above because they carry a
    // second lambda: the key `windowedBy` and `expandingBy` partition on, which
    // can read the parameter bag exactly as a projector can and is null for the
    // unpartitioned spellings. A `windowed` size needs nothing here, being a
    // plain number rather than a bag reference, as `take` and `skip` are.
    case 'windowed':
    case 'expanding':
      return {
        ...plan,
        source: rewritePlan(plan.source, renames),
        projector: rewriteLambda(plan.projector, renames),
        partition: plan.partition && rewriteLambda(plan.partition, renames),
      };

    case 'orderBy':
      return {
        ...plan,
        source: rewritePlan(plan.source, renames),
        keys: plan.keys.map((entry) => ({
          key: rewriteLambda(entry.key, renames),
          descending: entry.descending,
        })),
      };

    // `tag` is among these because it holds text rather than an expression, so
    // it has no bag reference of its own to rewrite and only its source does.
    case 'skip':
    case 'take':
    case 'last':
    case 'distinct':
    case 'sample':
    case 'defaultIfEmpty':
    case 'tag':
      return { ...plan, source: rewritePlan(plan.source, renames) };

    case 'zip':
      return {
        ...plan,
        source: rewritePlan(plan.source, renames),
        other: rewritePlan(plan.other, renames),
        third: plan.third && rewritePlan(plan.third, renames),
      };

    case 'sequenceEqual':
    case 'setOperation':
      return {
        ...plan,
        source: rewritePlan(plan.source, renames),
        other: rewritePlan(plan.other, renames),
      };

    case 'selectMany':
      return {
        ...plan,
        source: rewritePlan(plan.source, renames),
        over:
          plan.over.kind === 'query'
            ? { kind: 'query', plan: rewritePlan(plan.over.plan, renames) }
            : {
                kind: 'collection',
                selector: rewriteLambda(plan.over.selector, renames),
                shape: plan.over.shape && {
                  ...plan.over.shape,
                  plan: rewritePlan(plan.over.shape.plan, renames),
                },
              },
        projector: rewriteLambda(plan.projector, renames),
      };

    case 'groupJoin':
    case 'join':
      return {
        ...plan,
        source: rewritePlan(plan.source, renames),
        inner: rewritePlan(plan.inner, renames),
        outerKey: rewriteLambda(plan.outerKey, renames),
        innerKey: rewriteLambda(plan.innerKey, renames),
        projector: rewriteLambda(plan.projector, renames),
      };

    case 'perKey':
    case 'chunkBy':
      return {
        ...plan,
        source: rewritePlan(plan.source, renames),
        key: rewriteLambda(plan.key, renames),
      };

    case 'setOperationBy':
      return {
        ...plan,
        source: rewritePlan(plan.source, renames),
        other: rewritePlan(plan.other, renames),
        key: rewriteLambda(plan.key, renames),
        otherKey: rewriteLambda(plan.otherKey, renames),
      };

    case 'groupBy':
      return {
        ...plan,
        source: rewritePlan(plan.source, renames),
        key: rewriteLambda(plan.key, renames),
        projector: rewriteLambda(plan.projector, renames),
      };
  }
}

function rewriteLambda(
  node: LambdaExpression,
  renames: ReadonlyMap<string, string>,
): LambdaExpression {
  return { ...node, body: rewrite(node.body, renames) };
}

function rewrite(node: ExpressionNode, renames: ReadonlyMap<string, string>): ExpressionNode {
  switch (node.kind) {
    case 'constant':
    case 'regex':
    case 'parameter':
      return node;

    case 'external': {
      // Only the first segment names a bag; the rest is a path inside it.
      const [bagId, ...rest] = node.path;
      const renamed = bagId === undefined ? undefined : renames.get(bagId);
      return renamed ? external([renamed, ...rest]) : node;
    }

    case 'member':
      return { ...node, object: rewrite(node.object, renames) };

    case 'binary':
      return {
        ...node,
        left: rewrite(node.left, renames),
        right: rewrite(node.right, renames),
      };

    case 'unary':
      return { ...node, operand: rewrite(node.operand, renames) };

    case 'call':
      return {
        ...node,
        target: node.target ? rewrite(node.target, renames) : null,
        args: node.args.map((argument) => rewrite(argument, renames)),
      };

    case 'conditional':
      return {
        ...node,
        test: rewrite(node.test, renames),
        whenTrue: rewrite(node.whenTrue, renames),
        whenFalse: rewrite(node.whenFalse, renames),
      };

    case 'object':
      return {
        ...node,
        properties: node.properties.map((property) => ({
          name: property.name,
          value: rewrite(property.value, renames),
        })),
      };

    case 'array':
      return { ...node, elements: node.elements.map((element) => rewrite(element, renames)) };

    case 'lambda':
      return rewriteLambda(node, renames);
  }
}
