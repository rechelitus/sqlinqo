/**
 * A deliberately small JavaScript AST covering only what a query lambda may
 * contain.
 *
 * It stays separate from the expression IR in `../expression/nodes.ts` because
 * at this stage an identifier is still just a name: whether `p` is a row alias,
 * a parameter bag, or an unsupported closure capture is decided later, by the
 * binder, which is the only component that knows the lambda's calling context.
 */

export interface JsIdentifier {
  readonly type: 'identifier';
  readonly name: string;
  readonly start: number;
}

export interface JsLiteral {
  readonly type: 'literal';
  readonly value: string | number | boolean | null | undefined;
  readonly start: number;
}

export interface JsRegexLiteral {
  readonly type: 'regex';
  readonly source: string;
  readonly flags: string;
  readonly start: number;
}

export interface JsMember {
  readonly type: 'member';
  readonly object: JsNode;
  readonly property: string;
  readonly start: number;
}

export interface JsCall {
  readonly type: 'call';
  readonly callee: JsNode;
  readonly args: readonly JsNode[];
  readonly start: number;
}

export interface JsBinary {
  readonly type: 'binary';
  readonly operator: string;
  readonly left: JsNode;
  readonly right: JsNode;
  readonly start: number;
}

export interface JsUnary {
  readonly type: 'unary';
  readonly operator: string;
  readonly operand: JsNode;
  readonly start: number;
}

export interface JsConditional {
  readonly type: 'conditional';
  readonly test: JsNode;
  readonly whenTrue: JsNode;
  readonly whenFalse: JsNode;
  readonly start: number;
}

export interface JsObject {
  readonly type: 'object';
  readonly properties: readonly { readonly key: string; readonly value: JsNode }[];
  readonly start: number;
}

export interface JsArray {
  readonly type: 'array';
  readonly elements: readonly JsNode[];
  readonly start: number;
}

export interface JsArrow {
  readonly type: 'arrow';
  readonly params: readonly string[];
  readonly body: JsNode;
  readonly start: number;
}

export type JsNode =
  | JsIdentifier
  | JsLiteral
  | JsRegexLiteral
  | JsMember
  | JsCall
  | JsBinary
  | JsUnary
  | JsConditional
  | JsObject
  | JsArray
  | JsArrow;
