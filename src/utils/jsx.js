// @flow

import t from '../lib/babel-types';

type JSXChildren = Array<
  JSXText | JSXExpressionContainer | JSXSpreadChild | JSXElement | JSXFragment,
>;

export function buildJSXElement(
  tag: JSXIdentifier | JSXMemberExpression,
  attrs: Array<JSXAttribute | JSXSpreadAttribute>,
  children: JSXChildren,
): JSXElement {
  const noChildren = children.length === 0;

  const open = t.jSXOpeningElement(tag, attrs, noChildren);

  const close = noChildren ? null : t.jSXClosingElement(tag);

  return t.jSXElement(open, close, children, noChildren);
}

const isAllowedChild = item =>
  [
    'JSXText',
    'JSXExpressionContainer',
    'JSXSpreadChild',
    'JSXElement',
    'JSXFragment',
  ].includes(item.type);

export function buildJSXFragment(children: Array<any>): JSXFragment {
  const jSXChildren = children.map(item => {
    if (!isAllowedChild(item)) {
      if (item.type === 'StringLiteral') {
        return t.jSXText(item.value);
      }

      return t.jSXExpressionContainer(item);
    }

    return item;
  });

  return t.jSXFragment(
    t.jSXOpeningFragment(),
    t.jSXClosingFragment(),
    jSXChildren,
  );
}
