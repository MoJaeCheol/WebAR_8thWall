/**
 * 8-bit 그레이스케일 PNG 인코더.
 *
 * Immersal REST API 는 b64 필드에 "8-bit grayscale 또는 24-bit RGB PNG" 를 요구한다.
 * canvas.toDataURL('image/png') 은 브라우저마다 RGBA(32-bit)로 인코딩해서 거부될 수 있으므로
 * 포맷을 확실히 통제하기 위해 직접 인코딩한다.
 */
(function () {
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function adler32(bytes) {
    let a = 1;
    let b = 0;
    for (let i = 0; i < bytes.length; i++) {
      a = (a + bytes[i]) % 65521;
      b = (b + a) % 65521;
    }
    return ((b << 16) | a) >>> 0;
  }

  /** deflate 의 "stored(비압축) 블록" 으로 zlib 스트림을 만드는 폴백 경로. */
  function zlibStored(data) {
    const MAX = 65535;
    const blocks = Math.max(1, Math.ceil(data.length / MAX));
    const out = new Uint8Array(2 + blocks * 5 + data.length + 4);
    let o = 0;
    out[o++] = 0x78; // CMF: deflate, 32K window
    out[o++] = 0x01; // FLG
    for (let i = 0; i < blocks; i++) {
      const start = i * MAX;
      const len = Math.min(MAX, data.length - start);
      out[o++] = i === blocks - 1 ? 1 : 0; // BFINAL
      out[o++] = len & 0xff;
      out[o++] = (len >>> 8) & 0xff;
      out[o++] = ~len & 0xff;
      out[o++] = (~len >>> 8) & 0xff;
      out.set(data.subarray(start, start + len), o);
      o += len;
    }
    const ad = adler32(data);
    out[o++] = (ad >>> 24) & 0xff;
    out[o++] = (ad >>> 16) & 0xff;
    out[o++] = (ad >>> 8) & 0xff;
    out[o++] = ad & 0xff;
    return out;
  }

  async function zlibDeflate(data) {
    if (typeof CompressionStream === 'undefined') return zlibStored(data);
    try {
      // CompressionStream('deflate') 은 zlib(RFC1950) 래핑 출력이라 IDAT 에 그대로 쓸 수 있다.
      const cs = new CompressionStream('deflate');
      const stream = new Blob([data]).stream().pipeThrough(cs);
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (e) {
      return zlibStored(data);
    }
  }

  function chunk(type, data) {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  }

  /**
   * @param {Uint8Array} gray  width*height 크기의 8-bit 휘도 배열
   * @returns {Promise<string>} base64 (data URL 접두사 없음)
   */
  async function encodeGray8(gray, width, height) {
    // 각 스캔라인 앞에 filter byte(0 = None) 를 붙인다.
    const raw = new Uint8Array((width + 1) * height);
    for (let y = 0; y < height; y++) {
      raw[y * (width + 1)] = 0;
      raw.set(gray.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
    }

    const ihdr = new Uint8Array(13);
    const dv = new DataView(ihdr.buffer);
    dv.setUint32(0, width);
    dv.setUint32(4, height);
    ihdr[8] = 8;  // bit depth
    ihdr[9] = 0;  // color type 0 = grayscale
    ihdr[10] = 0; // compression
    ihdr[11] = 0; // filter
    ihdr[12] = 0; // interlace

    const idat = await zlibDeflate(raw);
    const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))];

    const total = parts.reduce((n, p) => n + p.length, 0);
    const png = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { png.set(p, o); o += p.length; }

    // Uint8Array → base64 (큰 배열에서 스택 넘치지 않게 청크 단위 처리)
    let bin = '';
    const CH = 0x8000;
    for (let i = 0; i < png.length; i += CH) {
      bin += String.fromCharCode.apply(null, png.subarray(i, i + CH));
    }
    return btoa(bin);
  }

  window.PNGEncoder = {encodeGray8};
})();
