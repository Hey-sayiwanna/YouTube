/*
 * YouTube iOS 首页 Feed Sponsored 广告定向补丁 v2
 *
 * 依据两份真实 HAR：同一类 Disney+/Hulu 首页广告存在两种 EML 包装：
 *   A: ... -> field #5 -> extension -> field #19 -> ad payload
 *   B: ... -> field #5 -> extension -> field #27 -> ad payload
 * 因此不再绑定 #19/#27，而是在“内容项 field #5”层级上识别广告并删除整个内容项，
 * 避免只删内部 renderer 后残留灰色/空白卡片。
 */
(() => {
  const MARKERS = [
    'googleadservices.com/pagead/aclk',
    'www.youtube.com/pagead/adview',
    'www.youtube.com/pagead/interaction',
    'www.youtube.com/aboutthisad?pf=ios'
  ];
  const enc = new TextEncoder();
  const markerBytes = MARKERS.map((s) => enc.encode(s));

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

  function isHighConfidenceAdPayload(p) {
    if (p.length < 512) return false;
    let hits = 0;
    for (const m of markerBytes) if (contains(p, m)) hits++;
    return hits >= 2;
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

  function looksLikeMessage(p) {
    if (!p.length) return false;
    try {
      let i = 0;
      while (i < p.length) {
        const [key, keyEnd] = readVarint(p, i, p.length);
        const fieldNo = Math.floor(key / 8);
        const wt = key & 7;
        if (!fieldNo || ![0, 1, 2, 5].includes(wt)) return false;
        if (wt === 0) {
          const [, e] = readVarint(p, keyEnd, p.length);
          i = e;
        } else if (wt === 1) {
          i = keyEnd + 8;
        } else if (wt === 5) {
          i = keyEnd + 4;
        } else {
          const [len, lenEnd] = readVarint(p, keyEnd, p.length);
          i = lenEnd + len;
        }
        if (i > p.length) return false;
      }
      return i === p.length;
    } catch (_) {
      return false;
    }
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
          parts.push(raw); total += raw.length; i = e;
          continue;
        }

        if (wt === 1 || wt === 5) {
          const e = keyEnd + (wt === 1 ? 8 : 4);
          if (e > a.length) return null;
          const raw = a.slice(fieldStart, e);
          parts.push(raw); total += raw.length; i = e;
          continue;
        }

        const [len, lenEnd] = readVarint(a, keyEnd, a.length);
        const payloadEnd = lenEnd + len;
        if (payloadEnd > a.length) return null;
        const payload = a.slice(lenEnd, payloadEnd);

        // 两份 HAR 中广告内部字段分别变成 #19 / #27，
        // 但完整 Feed 内容项的外层 field #5 保持一致。
        if (fieldNo === 5 && isHighConfidenceAdPayload(payload)) {
          localRemoved++;
          console.log(`[YT HomeFeed AdBlock v2] remove ad item field #5 at depth ${depth}, ${payload.length} bytes`);
          i = payloadEnd;
          continue;
        }

        let newPayload = payload;
        let childRemoved = 0;
        if (depth < 40 && looksLikeMessage(payload)) {
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
          parts.push(raw); total += raw.length;
        }
        i = payloadEnd;
      }
      return { bytes: concat(parts, total), removed: localRemoved };
    } catch (_) {
      return null;
    }
  }

  try {
    const input = $response.body instanceof Uint8Array
      ? $response.body
      : new Uint8Array($response.body);
    const result = cleanMessage(input, 0);

    if (result && result.removed > 0) {
      console.log(`[YT HomeFeed AdBlock v2] removed ${result.removed} sponsored item(s), ${input.length} -> ${result.bytes.length} bytes`);
      $done({ body: result.bytes });
    } else {
      console.log('[YT HomeFeed AdBlock v2] no matching sponsored item found');
      $done({});
    }
  } catch (e) {
    console.log(`[YT HomeFeed AdBlock v2] error: ${e}`);
    $done({});
  }
})();
