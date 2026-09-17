import * as Y from 'yjs';
import { TiptapTransformer } from '@hocuspocus/transformer';
import { tiptapExtensions } from './collaboration.util';
import { setYjsMark } from './yjs.util';

describe('Server-side inline comments', () => {
  it('resolves the same serialized relative selection sent by the read-only editor', () => {
    const doc = TiptapTransformer.toYdoc({ type:'doc', content:[{type:'paragraph', content:[{type:'text', text:'comment target'}]}] }, 'default', tiptapExtensions);
    const fragment = doc.getXmlFragment('default');
    const text = (fragment.get(0) as Y.XmlElement).get(0) as Y.XmlText;
    const selection = JSON.parse(JSON.stringify({
      anchor: Y.createRelativePositionFromTypeIndex(text, 0, -1),
      head: Y.createRelativePositionFromTypeIndex(text, text.length),
    }));
    setYjsMark(doc as any, fragment, selection, 'comment', { commentId:'test', resolved:false });
    expect(text.toDelta()).toEqual([{ insert:'comment target', attributes:{ comment:{commentId:'test',resolved:false} } }]);
    doc.destroy();
  });
});
