/*
 * YouTube iOS 首页 Feed Sponsored 广告定向补丁 v4
 *
 * v4 根据 2026-09-02 多份真实 HAR 修正 v2/v3 的“删得过大”问题：
 * - 不再删除整个 Feed 外层 field #5，也不再删除 field #777 EML 注册表；
 * - 仅递归删除 <= 40 KB 且同时命中 >= 2 个强广告端点标记的 protobuf 子消息；
 * - 这样可删除 Disney+/Hulu、ANEXT 等广告的实际创意/点击/曝光子块，同时保留 Feed 外层容器，避免 YouTube 因响应过空而回退到旧缓存内容。
 */
(() => {
  const MAX_AD_NODE_SIZE = 40 * 1024;
  const CORE_MARKERS = [
    'googleadservices.com/pagead/aclk',
    'www.youtube.com/pagead/adview',
    'www.youtube.com/pagead/interaction',
    'www.youtube.com/aboutthisad?pf=ios'
  ];

  const enc = new TextEncoder();
  const markerBytes = CORE_MARKERS.map((s) => enc.encode(s));

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

        // 核心策略：只删除“中小型、强广告证据”的子消息。
        // 不再删除 40 KB 以上的大容器，避免把整页 Feed 一起砍掉。
        if (payload.length <= MAX_AD_NODE_SIZE) {
          const hits = markerHits(payload);
          if (hits >= 2) {
            removed++;
            console.log(`[YT HomeFeed AdBlock v4] PRUNE field=${fieldNo} depth=${depth} bytes=${payload.length} hits=${hits}`);
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
          parts.push(raw); total += raw.length;
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

    const result = cleanMessage(input, 0);

    if (result && result.removed > 0) {
      console.log(`[YT HomeFeed AdBlock v4] DONE removed=${result.removed}, ${input.length} -> ${result.bytes.length} bytes`);
      $done({ body: result.bytes });
    } else {
      console.log(`[YT HomeFeed AdBlock v4] PASS no ad node, bytes=${input.length}`);
      $done({});
    }
  } catch (e) {
    console.log(`[YT HomeFeed AdBlock v4] ERROR ${e}`);
    $done({});
  }
})();
