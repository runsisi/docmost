import { Editor } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { describe, expect, it } from "vitest";
import { Heading } from "../../../../../../packages/editor-ext/src/lib/heading/heading";
import { LinkExtension } from "../../../../../../packages/editor-ext/src/lib/link";
import { UniqueID } from "../../../../../../packages/editor-ext/src/lib/unique-id";
import { markdownToHtml } from "../../../../../../packages/editor-ext/src/lib/markdown/utils/marked.utils";
import { htmlToMarkdown } from "../../../../../../packages/editor-ext/src/lib/markdown/utils/turndown.utils";
import {
  MarkdownAnchors,
  findAnchorTarget,
} from "../../../../../../packages/editor-ext/src/lib/anchors";
import { MarkdownClipboard } from "./markdown-clipboard";
import { normalizeUrl } from "@/lib/utils";

function createEditor(content: string | object) {
  return new Editor({
    extensions: [
      StarterKit.configure({ heading: false, link: false }),
      Heading,
      MarkdownAnchors,
      MarkdownClipboard.configure({ transformPastedText: true }),
      LinkExtension,
      UniqueID.configure({ types: ["heading", "paragraph"] }),
    ],
    content,
  });
}

function withEditor(content: string | object, check: (editor: Editor) => void) {
  const editor = createEditor(content);
  try {
    check(editor);
  } finally {
    editor.destroy();
  }
}

const appendix =
  '[附录 A](#fuse-index)\n\n<a id="fuse-index"></a>\n\n## 附录 A';

describe("Markdown anchors", () => {
  it("does not turn a fragment into an external URL", () => {
    expect(normalizeUrl("#fuse-index")).toBe("#fuse-index");
    expect(normalizeUrl("example.com")).toBe("https://example.com");
    expect(normalizeUrl("https://example.com/#foo")).toBe(
      "https://example.com/#foo",
    );
  });

  it("preserves an appendix link and target through JSON, HTML and Markdown round trips", () => {
    withEditor(markdownToHtml(appendix) as string, (editor) => {
      expect(editor.getHTML()).toContain('href="#fuse-index"');
      expect(editor.getHTML()).toContain('id="fuse-index"');
      expect(findAnchorTarget(editor.view.dom, "fuse-index")).not.toBeNull();
      withEditor(editor.getJSON(), (loaded) => {
        expect(findAnchorTarget(loaded.view.dom, "fuse-index")).not.toBeNull();
        const markdown = htmlToMarkdown(loaded.getHTML());
        expect(markdown).toContain('<a id="fuse-index"></a>');
        expect(markdown).toContain("[附录 A](#fuse-index)");
        withEditor(markdownToHtml(markdown) as string, (reimported) => {
          expect(
            findAnchorTarget(reimported.view.dom, "fuse-index"),
          ).not.toBeNull();
        });
      });
    });
  });

  it("preserves consecutive id/name anchors in paragraphs without a visible paragraph", () => {
    withEditor(
      '<p><a id="one"></a>\n<a name="two"></a></p><h2>Title</h2>',
      (editor) => {
        expect(editor.getJSON().content![0].type).toBe("anchorBlock");
        const target = findAnchorTarget(editor.view.dom, "one")!;
        expect(target).toBe(findAnchorTarget(editor.view.dom, "two"));
        expect(target.style.height).toBe("0px");
        const md = htmlToMarkdown(editor.getHTML());
        expect(md).toContain('<a id="one"></a><a name="two"></a>');
      },
    );
  });

  it("keeps inline anchor positions and exports their attributes safely", () => {
    withEditor(
      '<p>before<a id="a&amp;&quot;&lt;" name="alias"></a>after</p>',
      (editor) => {
        expect(
          editor.getJSON().content![0].content!.map((node) => node.type),
        ).toEqual(["text", "anchor", "text"]);
        expect(
          findAnchorTarget(editor.view.dom, encodeURIComponent('a&"<')),
        ).not.toBeNull();
        expect(htmlToMarkdown(editor.getHTML())).toContain(
          'before<a id="a&amp;&quot;&lt;" name="alias"></a>after',
        );
      },
    );
  });

  it("preserves explicit heading IDs separately from existing node IDs", () => {
    withEditor(
      '<h2 id="original" data-id="stable-node">Title</h2>',
      (editor) => {
        const heading = editor.getJSON().content![0];
        expect(heading.attrs).toMatchObject({
          id: "stable-node",
          anchorId: "original",
        });
        expect(findAnchorTarget(editor.view.dom, "original")).toBe(
          findAnchorTarget(editor.view.dom, "stable-node"),
        );
        expect(htmlToMarkdown(editor.getHTML())).toContain(
          '<a id="original"></a>',
        );
        withEditor(editor.getHTML(), (loaded) => {
          expect(loaded.getJSON().content![0].attrs).toMatchObject({
            id: "stable-node",
            anchorId: "original",
          });
        });
      },
    );
  });

  it("does not export existing Docmost IDs as authored anchors", () => {
    withEditor(
      '<h2 id="stable-node" data-id="stable-node">Title</h2>',
      (editor) => {
        expect(editor.getJSON().content![0].attrs!.anchorId).toBeNull();
        expect(htmlToMarkdown(editor.getHTML())).toBe("## Title");
      },
    );
  });

  it("generates GitHub-style aliases for Chinese, formatting, punctuation and duplicate headings", () => {
    withEditor(
      markdownToHtml(
        "## Hello, **World**!\n\n## 中文 标题\n\n## 中文 标题\n\n## 中文 标题-1",
      ) as string,
      (editor) => {
        const headings = [...editor.view.dom.querySelectorAll("h2")];
        expect(
          headings.map((node) => node.getAttribute("data-heading-anchor")),
        ).toEqual(["hello-world", "中文-标题", "中文-标题-1", "中文-标题-1-1"]);
        expect(
          findAnchorTarget(editor.view.dom, encodeURIComponent("中文-标题-1")),
        ).toBe(headings[2]);
        editor.commands.setContent("<h2>New title</h2>");
        expect(findAnchorTarget(editor.view.dom, "new-title")).not.toBeNull();
        expect(findAnchorTarget(editor.view.dom, "hello-world")).toBeNull();
        expect(JSON.stringify(editor.getJSON())).not.toContain(
          "data-heading-anchor",
        );
      },
    );
  });

  it("prioritizes node IDs, then explicit anchors, then generated aliases", () => {
    withEditor(
      '<h2>target</h2><a id="target"></a><a id="target"></a><p data-id="target">stable</p>',
      (editor) => {
        expect(findAnchorTarget(editor.view.dom, "target")!.tagName).toBe("P");
        editor.commands.setContent(
          '<h2>target</h2><a id="target"></a><a id="target"></a>',
        );
        expect(findAnchorTarget(editor.view.dom, "target")).toBe(
          editor.view.dom.querySelector('[data-type="anchorBlock"]'),
        );
      },
    );
  });

  it("rejects invalid encoding and missing targets and stays inside the current editor", () => {
    const outside = document.createElement("div");
    outside.id = "outside";
    document.body.append(outside);
    try {
      withEditor(
        '<h2>Title</h2><p><a id="a]b&quot;c"></a>Text</p>',
        (editor) => {
          expect(findAnchorTarget(editor.view.dom, "outside")).toBeNull();
          expect(findAnchorTarget(editor.view.dom, "%E0%A4")).toBeNull();
          expect(findAnchorTarget(editor.view.dom, "")).toBeNull();
          expect(findAnchorTarget(editor.view.dom, "missing")).toBeNull();
          expect(findAnchorTarget(editor.view.dom, "a]b%22c")).not.toBeNull();
        },
      );
    } finally {
      outside.remove();
    }
  });
  it("preserves targets when Markdown is pasted through the real clipboard plugin", () => {
    withEditor("<p></p>", (editor) => {
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", {
        value: {
          getData: (type: string) => (type === "text/plain" ? appendix : ""),
        },
      });
      editor.view.dom.dispatchEvent(event);
      expect(editor.getHTML()).toContain('href="#fuse-index"');
      expect(editor.getHTML()).toContain('id="fuse-index"');
      expect(findAnchorTarget(editor.view.dom, "fuse-index")).not.toBeNull();
    });
  });

  it("does not treat visible HTML inside a named anchor as an empty target", () => {
    withEditor('<p>before<a id="target"><br></a>after</p>', (editor) => {
      expect(
        editor.getJSON().content![0].content!.map((node) => node.type),
      ).toEqual(["text", "hardBreak", "text"]);
    });
    withEditor(
      '<div data-type="anchorBlock">Keep this text</div>',
      (editor) => {
        expect(editor.getText()).toContain("Keep this text");
      },
    );
  });
});
