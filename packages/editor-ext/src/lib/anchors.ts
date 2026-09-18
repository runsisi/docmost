import { Extension, Node as TiptapNode } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import GithubSlugger from 'github-slugger';

type NamedAnchor = { id: string | null; name: string | null };

const anchorSelector = 'a[id]:not([href]), a[name]:not([href])';

function readAnchor(element: HTMLElement): NamedAnchor {
  return { id: element.getAttribute('id'), name: element.getAttribute('name') };
}

function isEmptyAnchor(element: HTMLElement): boolean {
  return (
    element.matches(anchorSelector) &&
    element.children.length === 0 &&
    !element.textContent?.trim()
  );
}

// Markdown renderers may wrap consecutive empty anchors in a paragraph.
function emptyAnchors(element: HTMLElement): NamedAnchor[] | null {
  const anchors: NamedAnchor[] = [];
  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType === 3 && !child.textContent?.trim()) continue;
    if (child.nodeType !== 1 || !isEmptyAnchor(child as HTMLElement))
      return null;
    anchors.push(readAnchor(child as HTMLElement));
  }
  return anchors.length ? anchors : null;
}

function isInlineAnchor(element: HTMLElement): boolean {
  const parent = element.parentElement;
  return (
    !!parent &&
    /^(P|H[1-6]|SPAN|EM|STRONG|S|CODE|A)$/.test(parent.tagName) &&
    !(parent.tagName === 'P' && emptyAnchors(parent))
  );
}

function anchorNode(name: string, inline: boolean) {
  return TiptapNode.create({
    name,
    group: inline ? 'inline' : 'block',
    inline,
    atom: true,
    selectable: false,
    draggable: false,
    addAttributes() {
      return { anchors: { default: [], rendered: false } };
    },
    parseHTML() {
      return [
        {
          tag: `${inline ? 'span' : 'div'}[data-type="${name}"]`,
          getAttrs: (element: HTMLElement) => {
            const anchors = emptyAnchors(element);
            return anchors ? { anchors } : false;
          },
        },
        ...(!inline
          ? [
              {
                tag: 'p',
                priority: 100,
                getAttrs: (element: HTMLElement) => {
                  const anchors = emptyAnchors(element);
                  return anchors ? { anchors } : false;
                },
              },
            ]
          : []),
        ...['a[id]:not([href])', 'a[name]:not([href])'].map((tag) => ({
          tag,
          priority: 100,
          getAttrs: (element: HTMLElement) =>
            isEmptyAnchor(element) && isInlineAnchor(element) === inline
              ? { anchors: [readAnchor(element)] }
              : false,
        })),
      ];
    },
    renderHTML({ node }) {
      return [
        inline ? 'span' : 'div',
        {
          'data-type': name,
          contenteditable: 'false',
          'aria-hidden': 'true',
          style: inline
            ? 'display: inline-block; width: 0; height: 0; overflow: hidden;'
            : 'height: 0; margin: 0; padding: 0; overflow: hidden;',
        },
        ...(node.attrs.anchors as NamedAnchor[]).map(({ id, name }) => [
          'a',
          {
            ...(id !== null ? { id } : {}),
            ...(name !== null ? { name } : {}),
          },
        ]),
      ];
    },
  });
}

export const Anchor = anchorNode('anchor', true);
export const AnchorBlock = anchorNode('anchorBlock', false);

export const MarkdownAnchors = Extension.create({
  name: 'markdownAnchors',
  addExtensions() {
    return [Anchor, AnchorBlock];
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('markdownHeadingAnchors'),
        props: {
          decorations(state) {
            const slugger = new GithubSlugger();
            const decorations: Decoration[] = [];
            state.doc.descendants((node, pos) => {
              if (node.type.name === 'heading') {
                decorations.push(
                  Decoration.node(pos, pos + node.nodeSize, {
                    'data-heading-anchor': slugger.slug(node.textContent),
                  }),
                );
              }
            });
            return DecorationSet.create(state.doc, decorations);
          },
        },
      }),
    ];
  },
});

/** Fragment is URL-encoded. Search only the supplied document, never the app shell. */
export function findAnchorTarget(
  root: HTMLElement,
  fragment: string,
): HTMLElement | null {
  let id: string;
  try {
    id = decodeURIComponent(fragment);
  } catch {
    return null;
  }
  if (!id) return null;
  // Do not interpolate untrusted fragment text into a CSS selector.
  const nodes = Array.from(
    root.querySelectorAll<HTMLElement>('[id], [data-id], a[name]'),
  );
  const nodeId = nodes.find((node) => node.getAttribute('data-id') === id);
  if (nodeId) return nodeId;
  const explicit = nodes.find(
    (node) => node.id === id || node.getAttribute('name') === id,
  );
  if (explicit) {
    return (
      explicit.closest<HTMLElement>(
        '[data-type="anchor"], [data-type="anchorBlock"]',
      ) || explicit
    );
  }
  return (
    Array.from(
      root.querySelectorAll<HTMLElement>('[data-heading-anchor]'),
    ).find((node) => node.getAttribute('data-heading-anchor') === id) || null
  );
}
