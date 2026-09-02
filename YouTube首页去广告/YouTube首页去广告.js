/*
 * YouTube iOS 首页 Feed Sponsored 广告定向补丁 v3
 *
 * v3 根据 2026-09-02 17:18:57 的真实 HAR 再次修正：
 * 1. 删除包含 Google/YouTube 广告点击、曝光、About This Ad 标记的 Feed 内容项 field #5；
 * 2. 同时清除同一响应 field #777 中残留的 EML 广告组件注册表，避免主体删除后仍由 ad_badge / ad_image / feed_ad_metadata 等组件继续渲染或复用缓存广告卡片；
 * 3. 无广告的 browse 响应保持原样。
 */
(() => {
  const CORE_MARKERS = [
    'googleadservices.com/pagead/aclk',
    'www.youtube.com/pagead/adview',
    'www.youtube.com/pagead/interaction',
    'www.youtube.com/aboutthisad?pf=ios'
  ];
  const EML_MARKERS = [
    'ad_badge.eml-fe',
    'feed_ad_metadata.eml-fe',
    'ad_image.eml-fe',
    'ad_disclosure_banner.eml-fe'
  ];

  const enc = new TextEncoder();
  const coreBytes = CORE_MARKERS.map((s) => enc.encode(s));
  const emlBytes = EML_MARKERS.map((s) => enc.encode(s));

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

  function markerHits(payload, markers) {
    let hits = 0;
    for (const m of markers) if (contains(payload, m)) hits++;
    return hits;
  }

  function isHighConfidenceAdItem(payload) {
    return payload.length >= 512 && markerHits(payload, coreBytes) >= 2;
  }

  function isAdEmlRegistry(payload) {
    return payload.length >= 512 && markerHits(payload, emlBytes) >= 2;
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

  function cleanMessage(a, depth = 0, inside777 = false) {
    let i = 0;
    const parts = [];
    let total = 0;
    let coreRemoved = 0;
    let emlRemoved = 0;

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

        // 删除真正的 Sponsored Feed 内容项。
        if (fieldNo === 5 && isHighConfidenceAdItem(payload)) {
          coreRemoved++;
          console.log(`[YT HomeFeed AdBlock v3] remove sponsored field #5 depth=${depth}, bytes=${payload.length}`);
          i = payloadEnd;
          continue;
        }

        // 17:18:57 HAR 证明主体被删后，field #777 中仍残留整套广告 EML 组件。
        // 只在 #777 子树内且同时命中多个广告组件名称时删除该注册块。
        if (inside777 && isAdEmlRegistry(payload)) {
          emlRemoved++;
          console.log(`[YT HomeFeed AdBlock v3] remove ad EML registry depth=${depth}, field=${fieldNo}, bytes=${payload.length}`);
          i = payloadEnd;
          continue;
        }

        let newPayload = payload;
        let childCore = 0;
        let childEml = 0;
        if (depth < 50 && looksLikeMessage(payload)) {
          const child = cleanMessage(payload, depth + 1, inside777 || (depth === 0 && fieldNo === 777));
          if (child && (child.coreRemoved > 0 || child.emlRemoved > 0)) {
            newPayload = child.bytes;
            childCore = child.coreRemoved;
            childEml = child.emlRemoved;
          }
        }

        if (childCore > 0 || childEml > 0) {
          const keyBytes = a.slice(fieldStart, keyEnd);
          const lenBytes = writeVarint(newPayload.length);
          parts.push(keyBytes, lenBytes, newPayload);
          total += keyBytes.length + lenBytes.length + newPayload.length;
          coreRemoved += childCore;
          emlRemoved += childEml;
        } else {
          const raw = a.slice(fieldStart, payloadEnd);
          parts.push(raw); total += raw.length;
        }
        i = payloadEnd;
      }

      return { bytes: concat(parts, total), coreRemoved, emlRemoved };
    } catch (_) {
      return null;
    }
  }

  try {
    const input = $response.body instanceof Uint8Array
      ? $response.body
      : new Uint8Array($response.body);

    const result = cleanMessage(input, 0, false);

    if (result && (result.coreRemoved > 0 || result.emlRemoved > 0)) {
      console.log(`[YT HomeFeed AdBlock v3] DONE core=${result.coreRemoved}, eml=${result.emlRemoved}, ${input.length} -> ${result.bytes.length} bytes`);
      $done({ body: result.bytes });
    } else {
      console.log('[YT HomeFeed AdBlock v3] PASS no sponsored item');
      $done({});
    }
  } catch (e) {
    console.log(`[YT HomeFeed AdBlock v3] ERROR ${e}`);
    $done({});
  }
})();
