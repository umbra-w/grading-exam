/**
 * 基于 pdfjs-dist 的本地答题卡 PDF 渲染适配器 (Phase A1)。
 *
 * 将用户拖入的整本/多页答题卡 PDF 逐页渲染为高清晰度 Canvas 或 DataURL。
 * 纯前端完成，无需向后端或本机 Python 服务发送文件。
 */

export interface RenderedPdfPage {
  pageNumber: number;
  dataUrl: string;
  width: number;
  height: number;
}

/**
 * 将 Base64 或 ArrayBuffer 形式的 PDF 文档逐页提取为图片。
 */
export async function renderPdfToPages(
  pdfBufferOrDataUrl: ArrayBuffer | string,
  scale = 1.5
): Promise<RenderedPdfPage[]> {
  try {
    const pdfjsLib = await import('pdfjs-dist');
    // 配置 worker 路径为标准 cdn 或内置降级，单测环境下若无 worker 会使用主线程 fallback
    if (pdfjsLib.GlobalWorkerOptions && !pdfjsLib.GlobalWorkerOptions.workerSrc) {
      pdfjsLib.GlobalWorkerOptions.workerSrc =
        'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs';
    }

    let loadingTask;
    if (typeof pdfBufferOrDataUrl === 'string') {
      loadingTask = pdfjsLib.getDocument(pdfBufferOrDataUrl);
    } else {
      loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(pdfBufferOrDataUrl) });
    }

    const pdfDoc = await loadingTask.promise;
    const numPages = pdfDoc.numPages;
    const pages: RenderedPdfPage[] = [];

    for (let i = 1; i <= numPages; i++) {
      const page = await pdfDoc.getPage(i);
      const viewport = page.getViewport({ scale });

      if (typeof document !== 'undefined') {
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext('2d');

        if (ctx) {
          await page.render({ canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport }).promise;
          pages.push({
            pageNumber: i,
            dataUrl: canvas.toDataURL('image/jpeg', 0.92),
            width: viewport.width,
            height: viewport.height,
          });
        }
      }
    }

    return pages;
  } catch (err) {
    // 若在没有 DOM 的单测环境或解析损坏时，优雅抛错或降级
    throw new Error(`PDF 渲染失败：${(err as Error)?.message ?? String(err)}`);
  }
}
