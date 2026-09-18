import { JSONContent, getSchema } from '@tiptap/core';
import {
  defaultAsyncNodes,
  defaultMarks,
  NodeSerializerAsync,
  pageNodeToDocxBuffer,
} from '@docmost/editor-ext';
import { ImageRun, TextRun, LevelFormat } from 'docx';
import { imageDimensionsFromData } from 'image-dimensions';
import {
  jsonToNode,
  tiptapExtensions,
} from '../../collaboration/collaboration.util';

export type ExportImage = { data: Buffer } | { warning: string };

const nodeLabels: Record<string, string> = {
  image: '图片',
  drawio: 'Draw.io 图示',
  excalidraw: 'Excalidraw 图示',
  subpages: '子页面列表',
  transclusionReference: '引用块引用',
  base: 'Base 数据表',
  video: '视频',
  audio: '音频',
  pdf: 'PDF',
  attachment: '附件',
  embed: '网页嵌入',
  youtube: 'YouTube 视频',
};

/** All replacements operate on a copy of the saved document. */
export async function createPageDocx(
  content: JSONContent,
  title: string,
  resolveImage: (attrs: Record<string, any>) => Promise<ExportImage>,
) {
  const warnings: string[] = [];
  const warning = (message: string) => {
    warnings.push(message);
    return `[Word 导出说明：${message}]`;
  };
  const schema = getSchema(tiptapExtensions);
  const structuralNodes = new Set([
    'doc',
    'tableRow',
    'tableCell',
    'tableHeader',
  ]);
  const normalize = (node: JSONContent, inline = false): JSONContent => {
    if (!node.type) throw new Error('Saved document node has no type');
    if (
      !schema.nodes[node.type] ||
      (!defaultAsyncNodes[node.type] && !structuralNodes.has(node.type))
    ) {
      const text = {
        type: 'text',
        text: warning(`不支持的内容（${node.type}），未转换`),
      };
      return inline ? text : { type: 'paragraph', content: [text] };
    }
    const unsupportedMarks = node.marks?.filter(
      (mark) => !defaultMarks[mark.type],
    );
    if (unsupportedMarks?.length) {
      node.marks = node.marks.filter((mark) => defaultMarks[mark.type]);
      // Keep the original text and make the lost formatting visible in place.
      if (node.type === 'text') {
        node.text += warning(
          `文字样式 ${unsupportedMarks.map((mark) => mark.type).join(', ')} 未转换`,
        );
      }
    }
    if (node.content) {
      node.content = node.content.map((child) =>
        normalize(child, schema.nodes[node.type].isTextblock),
      );
    }
    return node;
  };
  if (content.type !== 'doc')
    throw new Error('Saved content is not a document');
  const copied = normalize(structuredClone(content));
  copied.content = [
    {
      type: 'heading',
      attrs: { level: 1 },
      content: [{ type: 'text', text: title }],
    },
    ...(copied.content || []),
  ];
  const placeholder: NodeSerializerAsync[string] = (state, node) => {
    state.text(warning(`${nodeLabels[node.type.name]}内容未转换`));
    if (!node.isInline) state.closeBlock(node);
  };
  const image: NodeSerializerAsync[string] = async (state, node) => {
    const result = await resolveImage(node.attrs);
    if ('warning' in result) {
      state.text(warning(`${nodeLabels[node.type.name]}：${result.warning}`));
    } else {
      const type = imageType(result.data);
      let dimensions: { width: number; height: number } | undefined;
      try {
        dimensions = type ? imageDimensionsFromData(result.data) : undefined;
      } catch {
        // Image bytes are external input; a corrupt image is a local degradation.
      }
      if (
        !type ||
        !dimensions ||
        dimensions.width <= 0 ||
        dimensions.height <= 0
      ) {
        state.text(
          warning(
            `${nodeLabels[node.type.name]}：图片格式不支持或文件损坏（支持 PNG、JPEG、GIF、BMP）`,
          ),
        );
      } else {
        const width = Math.min(dimensions.width, state.maxImageWidth);
        state.current.push(
          new ImageRun({
            data: result.data,
            type,
            transformation: {
              width,
              height: (width * dimensions.height) / dimensions.width,
            },
          }),
        );
      }
    }
    state.closeBlock(node);
  };
  const math: NodeSerializerAsync[string] = (state, node) => {
    state.text(
      `${node.attrs.text || ''} ${warning('公式保留为 LaTeX 文本，未转换为排版公式')}`,
    );
    if (!node.isInline) state.closeBlock(node);
  };
  const media: NodeSerializerAsync[string] = (state, node) => {
    const label =
      node.attrs.name || node.attrs.src || node.attrs.url || node.type.name;
    state.text(
      `${label} ${warning(`${nodeLabels[node.type.name]}仅保留名称或链接`)}`,
    );
    state.closeBlock(node);
  };
  // Each list gets its own numbering definition so mixed nested lists and
  // ordered-list start values survive serialization.
  const list: NodeSerializerAsync[string] = async (state, node) => {
    const previous = state.currentNumbering;
    const level = previous ? previous.level + 1 : 0;
    if (level > 8) {
      state.text(warning('列表嵌套超过 Word 支持的 9 层，已展开'));
      state.closeBlock(node);
    }
    const wordLevel = Math.min(level, 8);
    const reference = `docmost-list-${state.numbering.length}`;
    const ordered = node.type.name === 'orderedList';
    state.numbering.push({
      reference,
      levels: [
        {
          level: wordLevel,
          format: ordered ? LevelFormat.DECIMAL : LevelFormat.BULLET,
          text: ordered ? `%${wordLevel + 1}.` : '●',
          start: ordered ? node.attrs.start : 1,
          style: {
            paragraph: {
              indent: { left: (wordLevel + 1) * 720, hanging: 260 },
            },
          },
        },
      ],
    });
    state.currentNumbering = { reference, level: wordLevel };
    await state.renderContent(node);
    state.currentNumbering = previous;
  };
  const buffer = await pageNodeToDocxBuffer(
    jsonToNode(copied),
    () => {
      throw new Error('Images must use the permission-aware resolver');
    },
    {
      image,
      drawio: image,
      excalidraw: image,
      bulletList: list,
      orderedList: list,
      taskList: list,
      hardBreak(state) {
        state.current.push(new TextRun({ break: 1 }));
      },
      async table(state, node) {
        // docx defaults to physical cell count; merged cells need a grid whose
        // width is the logical column count instead.
        let columns = 0;
        node.forEach((row) => {
          let count = 0;
          row.forEach((cell) => {
            count += cell.attrs.colspan;
          });
          columns = Math.max(columns, count);
        });
        await state.table(node, {
          tableOptions: {
            columnWidths: Array(columns).fill(9000 / columns),
          },
        });
      },
      mathInline: math,
      mathBlock: math,
      video: media,
      audio: media,
      pdf: media,
      attachment: media,
      embed: media,
      youtube: media,
      subpages: placeholder,
      transclusionReference: placeholder,
      base: placeholder,
      async columns(state, node) {
        state.text(warning('多栏内容已按顺序展开'));
        state.closeBlock(node);
        await state.renderContent(node);
      },
    },
  );
  return { buffer, warningCount: warnings.length };
}

// Use file signatures rather than the filename or the editor's MIME metadata.
function imageType(data: Buffer): 'png' | 'jpg' | 'gif' | 'bmp' | undefined {
  if (
    data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return 'png';
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpg';
  if (/^GIF8[79]a$/.test(data.toString('ascii', 0, 6))) return 'gif';
  if (data.toString('ascii', 0, 2) === 'BM') return 'bmp';
  return undefined;
}
