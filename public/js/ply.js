/**
 * 최소 PLY 파서 — Immersal 이 내려주는 sparse 포인트 클라우드용.
 *
 * 형식 예:
 *   ply
 *   format binary_little_endian 1.0
 *   element vertex 2487
 *   property float x / y / z
 *   property uchar red / green / blue
 *   end_header
 *
 * ascii 형식도 함께 지원한다(맵에 따라 다를 수 있음).
 */
(function () {
  const TYPE_SIZE = {
    char: 1, uchar: 1, int8: 1, uint8: 1,
    short: 2, ushort: 2, int16: 2, uint16: 2,
    int: 4, uint: 4, int32: 4, uint32: 4, float: 4, float32: 4,
    double: 8, float64: 8,
  };

  function readType(dv, offset, type, littleEndian) {
    switch (type) {
      case 'char': case 'int8': return dv.getInt8(offset);
      case 'uchar': case 'uint8': return dv.getUint8(offset);
      case 'short': case 'int16': return dv.getInt16(offset, littleEndian);
      case 'ushort': case 'uint16': return dv.getUint16(offset, littleEndian);
      case 'int': case 'int32': return dv.getInt32(offset, littleEndian);
      case 'uint': case 'uint32': return dv.getUint32(offset, littleEndian);
      case 'float': case 'float32': return dv.getFloat32(offset, littleEndian);
      case 'double': case 'float64': return dv.getFloat64(offset, littleEndian);
      default: return 0;
    }
  }

  /**
   * @param {ArrayBuffer} buffer
   * @returns {{count:number, positions:Float32Array, colors:Float32Array|null}}
   */
  function parse(buffer) {
    const bytes = new Uint8Array(buffer);

    // 헤더는 항상 아스키. end_header 까지만 문자열로 읽는다.
    const HEADER_LIMIT = Math.min(bytes.length, 8192);
    let headerText = '';
    for (let i = 0; i < HEADER_LIMIT; i++) headerText += String.fromCharCode(bytes[i]);
    const endIdx = headerText.indexOf('end_header');
    if (endIdx < 0) throw new Error('PLY 헤더를 찾을 수 없음');
    const headerEnd = headerText.indexOf('\n', endIdx) + 1;

    const lines = headerText.slice(0, endIdx).split(/\r?\n/);
    let format = 'ascii';
    let count = 0;
    const props = [];
    let inVertex = false;

    for (const raw of lines) {
      const t = raw.trim().split(/\s+/);
      if (t[0] === 'format') {
        format = t[1];
      } else if (t[0] === 'element') {
        inVertex = t[1] === 'vertex';
        if (inVertex) count = parseInt(t[2], 10);
      } else if (t[0] === 'property' && inVertex) {
        if (t[1] === 'list') throw new Error('list 속성은 지원하지 않음');
        props.push({type: t[1], name: t[2]});
      }
    }
    if (!count) return {count: 0, positions: new Float32Array(0), colors: null};

    const idx = (n) => props.findIndex((p) => p.name === n);
    const ix = idx('x'); const iy = idx('y'); const iz = idx('z');
    if (ix < 0 || iy < 0 || iz < 0) throw new Error('x/y/z 속성이 없음');
    const ir = idx('red'); const ig = idx('green'); const ib = idx('blue');
    const hasColor = ir >= 0 && ig >= 0 && ib >= 0;

    const positions = new Float32Array(count * 3);
    const colors = hasColor ? new Float32Array(count * 3) : null;

    if (format === 'ascii') {
      const body = new TextDecoder().decode(bytes.subarray(headerEnd));
      const rows = body.split(/\r?\n/).filter((l) => l.trim());
      for (let i = 0; i < count && i < rows.length; i++) {
        const v = rows[i].trim().split(/\s+/).map(Number);
        positions[i * 3] = v[ix];
        positions[i * 3 + 1] = v[iy];
        positions[i * 3 + 2] = v[iz];
        if (hasColor) {
          colors[i * 3] = v[ir] / 255;
          colors[i * 3 + 1] = v[ig] / 255;
          colors[i * 3 + 2] = v[ib] / 255;
        }
      }
      return {count, positions, colors};
    }

    const littleEndian = format !== 'binary_big_endian';
    const offsets = [];
    let stride = 0;
    for (const p of props) {
      offsets.push(stride);
      const sz = TYPE_SIZE[p.type];
      if (!sz) throw new Error('알 수 없는 속성 타입: ' + p.type);
      stride += sz;
    }

    const dv = new DataView(buffer, headerEnd);
    const available = Math.floor((buffer.byteLength - headerEnd) / stride);
    const n = Math.min(count, available);

    for (let i = 0; i < n; i++) {
      const base = i * stride;
      positions[i * 3] = readType(dv, base + offsets[ix], props[ix].type, littleEndian);
      positions[i * 3 + 1] = readType(dv, base + offsets[iy], props[iy].type, littleEndian);
      positions[i * 3 + 2] = readType(dv, base + offsets[iz], props[iz].type, littleEndian);
      if (hasColor) {
        colors[i * 3] = readType(dv, base + offsets[ir], props[ir].type, littleEndian) / 255;
        colors[i * 3 + 1] = readType(dv, base + offsets[ig], props[ig].type, littleEndian) / 255;
        colors[i * 3 + 2] = readType(dv, base + offsets[ib], props[ib].type, littleEndian) / 255;
      }
    }

    return {count: n, positions, colors};
  }

  window.PLY = {parse};
})();
