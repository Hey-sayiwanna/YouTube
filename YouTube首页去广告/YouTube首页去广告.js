/*
 * YouTube iOS 首页 Feed Sponsored 广告定向补丁 v6
 *
 * v5 已能删除广告内部的创意/点击子节点，但会留下外层 Feed 卡片容器，
 * 导致首页出现灰色/黑色空框。
 * v6 改为：识别包含 >=2 个强广告端点标记的完整 Feed item（field #5），
 * 直接删除整个 item，而不是只删除内部 field #7/#8。
 * 这样广告卡片本身不会进入客户端布局，自然也不会留下空白占位。
 */
(() => {
  const CORE_MARKERS = [
    'googleadservices.com/pagead/aclk',
    'www.youtube.com/pagead/adview',
    'www.youtube.com/pagead/interaction',
    'www.youtube.com/aboutthisad?pf=ios'
  ];

  function asciiBytes(s) {
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
    return out;
  }

  const markerBytes = CORE_MARKERS.map(asciiBytes);

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

  function markerHits(payload) {
    let hits = 0;
    for (const m of markerBytes) if (contains(payload, m)) hits++;
    return hits;
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
    let removed = 0;

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
        const payloadEnd = lenEnd + len;
        if (payloadEnd > a.length) return null;
        const payload = a.slice(lenEnd, payloadEnd);

        // 真实 HAR 中 Sponsored 卡片的完整 Feed item 均落在 field #5。
        // 只有同时命中 >=2 个强广告端点时才删除，避免误伤普通推荐。
        if (fieldNo === 5 && payload.length >= 512) {
          const hits = markerHits(payload);
          if (hits >= 2) {
            removed++;
            console.log(`[YT HomeFeed AdBlock v6] DROP ITEM field=5 depth=${depth} bytes=${payload.length} hits=${hits}`);
            i = payloadEnd;
            continue;
          }
        }

        let newPayload = payload;
        let childRemoved = 0;
        if (depth < 60 && looksLikeMessage(payload)) {
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
          removed += childRemoved;
        } else {
          const raw = a.slice(fieldStart, payloadEnd);
          parts.push(raw);
          total += raw.length;
        }
        i = payloadEnd;
      }

      return { bytes: concat(parts, total), removed };
    } catch (_) {
      return null;
    }
  }

  try {
    const input = $response.body instanceof Uint8Array
      ? $response.body
      : new Uint8Array($response.body);

    console.log(`[YT HomeFeed AdBlock v6] START bytes=${input.length}`);
    const result = cleanMessage(input, 0);

    if (result && result.removed > 0) {
      console.log(`[YT HomeFeed AdBlock v6] DONE items=${result.removed}, ${input.length} -> ${result.bytes.length} bytes`);
      $done({ body: result.bytes });
    } else {
      console.log(`[YT HomeFeed AdBlock v6] PASS no sponsored item, bytes=${input.length}`);
      $done({});
    }
  } catch (e) {
    console.log(`[YT HomeFeed AdBlock v6] ERROR ${e}`);
    $done({});
  }
})();
