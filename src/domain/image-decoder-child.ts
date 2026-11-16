import sharp from 'sharp';
import type { ImageMimeType } from './dish-models.js';

interface DecodeMessage {
  type?: string;
  id?: number;
  data?: Buffer;
}

const ALLOWED_FORMATS: Record<string, ImageMimeType> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

sharp.cache(false);
sharp.concurrency(1);

function classifyError(error: unknown): 'invalid' | 'unsupported' {
  const message = error instanceof Error ? error.message : '';
  if (/unsupported image format|unsupported input|Input buffer contains unsupported/i.test(message)) {
    return 'unsupported';
  }
  return 'invalid';
}

process.on('message', (message: DecodeMessage) => {
  if (!message || message.type !== 'decode' || !message.id || !message.data) return;
  const id = message.id;
  const data = message.data;

  void (async () => {
    try {
      const input = Buffer.isBuffer(data) ? data : Buffer.from(data);
      const image = sharp(input, {
        failOn: 'error',
        animated: true,
        limitInputPixels: false,
        sequentialRead: true,
      });
      const metadata = await image.metadata();
      const mimeType = metadata.format ? ALLOWED_FORMATS[metadata.format] : undefined;
      if (!mimeType) {
        process.send?.({ id, ok: false, kind: 'unsupported' });
        return;
      }
      await image.toBuffer();
      process.send?.({ id, ok: true, mimeType });
    } catch (error) {
      process.send?.({ id, ok: false, kind: classifyError(error) });
    }
  })();
});
