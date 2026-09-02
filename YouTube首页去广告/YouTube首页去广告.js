/*
 * YouTube iOS 首页 Feed Sponsored 广告定向补丁
 * 基于真实 HAR 抓包定位：广告块位于嵌套 protobuf field #19，且包含 Google/YouTube pagead/about-this-ad 强特征。
 * 仅在同时命中这些强广告特征时删除对应 field #19，避免误删正常推荐内容。
 */
(() => {
  const MARKERS = [
    'googleadservices.com/pagead/',
    'www.youtube.com/pagead/',
    '/aboutthisad?pf=ios'
  ];
  const enc = new TextEncoder();
  const markerBytes = MARKERS.map(s => enc.encode(s));
  let removed = 0;

  function readVarint(a, i, end) {
    let v = 0, shift = 0, p = i;
    while (p < end && shift < 56) {
      const c = a[p++];
      v += (c & 0x7f) * Math.pow(2, shift);
      if (c < 0x80) return [v, p];
      shift += 7;
    }
    throw new Error('bad varint');
  }

  function writeVarint(v) {
    const out = [];
    while (v >= 0x80) {
      out.push((v % 128) | 0x80);
      v = Math.floor(v / 128);
    }
    out.push(v);
    return new Uint8Array(out);
  }

  function contains(hay, needle) {
    outer: for (let i = 0; i <= hay.length - needle.length; i++) {
      for (let j = 0; j < needle.length; j++) {
        if (hay[i + j] !== needle[j]) continue outer;
      }
      return true;
    }
    return false;
  }

  function isAdPayload(p) {
    let hits = 0;
    for (const m of markerBytes) if (contains(p, m)) hits++;
    return hits >= 1;
  }

  function mostlyPrintable(p) {
    const n = Math.min(p.length, 512);
    if (!n) return false;
    let ok = 0;
    for (let i = 0; i < n; i++) {
      const c = p[i];
      if ((c >= 32 && c <= 126) || c === 9 || c === 10 || c === 13) ok++;
    }
    return ok / n > 0.92;
  }

  function concat(parts, total) {
    const out = new Uint8Array(total);
    let p = 0;
    for (const x of parts) {
      out.set(x, p);
      p += x.length;
    }
    return out;
  }

  function cleanMessage(a, depth = 0) {
    let i = 0;
    const parts = [];
    let total = 0;
    let localRemoved = 0;

    try {
      while (i < a.length) {
        const fieldStart = i;
        const [key, keyEnd] = readVarint(a, i, a.length);
        const fieldNo = Math.floor(key / 8);
        const wt = key & 7;
        if (!fieldNo || ![0, 1, 2, 5].includes(wt)) return null;

        if (wt === 0) {
          const [, e] = readVarint(a, keyEnd, a.length);
          const raw = a.slice(fieldStart, e);
          parts.push(raw);
          total += raw.length;
          i = e;
          continue;
        }

        if (wt === 1 || wt === 5) {
          const e = keyEnd + (wt === 1 ? 8 : 4);
          if (e > a.length) return null;
          const raw = a.slice(fieldStart, e);
          parts.push(raw);
          total += raw.length;
          i = e;
          continue;
        }

        const [len, lenEnd] = readVarint(a, keyEnd, a.length);
        const payloadStart = lenEnd;
        const payloadEnd = payloadStart + len;
        if (payloadEnd > a.length) return null;
        const payload = a.slice(payloadStart, payloadEnd);

        // 真实 HAR 证据：整张 Sponsored Feed 卡片位于 field #19，
        // 且内部包含 Google/YouTube pagead/about-this-ad URL。
        if (fieldNo === 19 && isAdPayload(payload)) {
          localRemoved++;
          removed++;
          i = payloadEnd;
          continue;
        }

        let newPayload = payload;
        let childRemoved = 0;
        if (depth < 30 && payload.length && !mostlyPrintable(payload)) {
          const child = cleanMessage(payload, depth + 1);
          if (child && child.removed > 0) {
            newPayload = child.bytes;
            childRemoved = child.removed;
          }
        }

        if (childRemoved > 0) {
          const keyBytes = a.slice(fieldStart, keyEnd);
          const lenBytes = writeVarint(newPayload.length);
          parts.push(keyBytes, lenBytes, newPayload);
          total += keyBytes.length + lenBytes.length + newPayload.length;
          localRemoved += childRemoved;
        } else {
          const raw = a.slice(fieldStart, payloadEnd);
          parts.push(raw);
          total += raw.length;
        }
        i = payloadEnd;
      }

      return { bytes: concat(parts, total), removed: localRemoved };
    } catch (_) {
      return null;
    }
  }

  try {
    removed = 0;
    const input = $response.body instanceof Uint8Array
      ? $response.body
      : new Uint8Array($response.body);
    const result = cleanMessage(input, 0);

    if (result && result.removed > 0) {
      console.log(`[YT HomeFeed AdBlock] removed ${result.removed} sponsored field(s), ${input.length} -> ${result.bytes.length} bytes`);
      $done({ body: result.bytes });
    } else {
      console.log('[YT HomeFeed AdBlock] no matching sponsored field found');
      $done({});
    }
  } catch (e) {
    console.log(`[YT HomeFeed AdBlock] error: ${e}`);
    $done({});
  }
})();
