const MAX_BYTES = 600 * 1024;

function drawToCanvas(source, width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, width);
  canvas.height = Math.max(1, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function scaledSize(width, height, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

async function decode(file) {
  try {
    return { source: await createImageBitmap(file, { imageOrientation: 'from-image' }), url: '' };
  } catch {
    try {
      return { source: await createImageBitmap(file), url: '' };
    } catch {
      /* try an Image element, which is how iOS often decodes camera photos */
    }
  }
  const url = URL.createObjectURL(file);
  const source = await new Promise((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => {
      URL.revokeObjectURL(url);
      reject(Object.assign(new Error('invalid_photo'), { code: 'invalid_photo' }));
    };
    el.src = url;
  });
  return { source, url };
}

function jpegWithinCap(canvas) {
  for (const q of [0.75, 0.65, 0.55, 0.45, 0.4]) {
    const dataUrl = canvas.toDataURL('image/jpeg', q);
    const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    if ((b64.length * 3) / 4 <= MAX_BYTES) return b64;
  }
  return '';
}

/**
 * Downscale and compress a photo to a JPEG base64 string under the 600 KB cap.
 * Throws an Error with code photo_too_large or invalid_photo.
 */
export async function fileToJpegBase64(file, maxSide = 1280) {
  if (!file) {
    throw Object.assign(new Error('invalid_photo'), { code: 'invalid_photo' });
  }
  const decoded = await decode(file);
  const source = decoded.source;
  try {
    const naturalW = source.width || source.naturalWidth;
    const naturalH = source.height || source.naturalHeight;
    if (!naturalW || !naturalH) {
      throw Object.assign(new Error('invalid_photo'), { code: 'invalid_photo' });
    }
    let side = maxSide;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const size = scaledSize(naturalW, naturalH, side);
      const canvas = drawToCanvas(source, size.width, size.height);
      const b64 = jpegWithinCap(canvas);
      if (b64) return b64;
      side = Math.round(side * 0.65);
    }
    throw Object.assign(new Error('photo_too_large'), { code: 'photo_too_large' });
  } finally {
    source.close?.();
    if (decoded.url) URL.revokeObjectURL(decoded.url);
  }
}
