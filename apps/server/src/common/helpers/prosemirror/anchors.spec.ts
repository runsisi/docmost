import {
  markdownToHtml,
  htmlToMarkdown,
  pageNodeToDocxBuffer,
} from '@docmost/editor-ext';
import {
  htmlToJson,
  jsonToHtml,
  jsonToNode,
} from '../../../collaboration/collaboration.util';
import { TiptapTransformer } from '@hocuspocus/transformer';
import { tiptapExtensions } from '../../../collaboration/collaboration.util';

describe('Markdown anchor persistence', () => {
  it('preserves targets and href through server conversion, Yjs and export', async () => {
    const markdown =
      '[附录 A](#fuse-index)\n\n<a id="fuse-index"></a>\n<a name="source-index"></a>\n\n## 附录 A\n\nBefore<a id="inline"></a>after';
    const json = htmlToJson(await markdownToHtml(markdown));
    expect(jsonToNode(json).textContent).toContain('附录 A');
    const ydoc = TiptapTransformer.toYdoc(json, 'default', tiptapExtensions);
    try {
      const restored = TiptapTransformer.fromYdoc(ydoc, 'default');
      const html = jsonToHtml(restored);
      expect(html).toContain('href="#fuse-index"');
      expect(html).toContain('id="fuse-index"');
      expect(html).toContain('name="source-index"');
      expect(html).toContain('id="inline"');
      const exported = htmlToMarkdown(html);
      expect(exported).toContain('[附录 A](#fuse-index)');
      expect(exported).toContain('<a id="fuse-index"></a>');
      expect(exported).toContain('<a name="source-index"></a>');
      expect(exported).toContain('Before<a id="inline"></a>after');
      const reimported = jsonToHtml(htmlToJson(await markdownToHtml(exported)));
      expect(reimported).toContain('id="fuse-index"');
    } finally {
      ydoc.destroy();
    }
  });

  it('keeps heading node identities and authored IDs separate', () => {
    const json = htmlToJson('<h2 id="original" data-id="stable">Title</h2>');
    expect(json.content[0].attrs).toMatchObject({
      id: 'stable',
      anchorId: 'original',
    });
    const loaded = htmlToJson(jsonToHtml(json));
    expect(loaded.content[0].attrs).toMatchObject({
      id: 'stable',
      anchorId: 'original',
    });
  });
  it('exports documents containing invisible anchors to Word without dropping visible text', async () => {
    const node = jsonToNode(
      htmlToJson(
        '<a id="start"></a><h2>Title</h2><p>Before<a name="inline"></a>after</p>',
      ),
    );
    const buffer = await pageNodeToDocxBuffer(node, async () => {
      throw new Error('No images expected');
    });
    const JSZip = require('jszip');
    const zip = await JSZip.loadAsync(buffer);
    const xml = await zip.file('word/document.xml').async('string');
    expect(xml).toContain('Title');
    expect(xml).toContain('Before');
    expect(xml).toContain('after');
  });
});
