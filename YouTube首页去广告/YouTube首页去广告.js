/*
 * YouTube iOS 首页 Feed Sponsored 广告补丁 v8
 *
 * v8 修复 v7 的路径假设错误：YouTube 的 Home Feed 容器 field #49399797
 * 不再固定出现在 top-level field #10；实测同一 App/账号可切换到
 * field #9 -> 58173949 -> 1 -> 58174010 -> 4 -> 49399797。
 *
 * 新策略：
 * - 在前 8 层 protobuf 中低内存搜索 field #49399797；
 * - 在该容器的直接子项中删除：
 *   1) field #1 且命中 >=2 个广告端点的新 Feed Sponsored item；
 *   2) field #32 且命中 >=2 个广告端点的旧 Feed Sponsored item；
 *   3) v5/v6 可能留下的已知 EML 空壳；
 * - 同时删除紧邻被删 item 的 cell_divider，避免灰/黑占位。
 * - 使用 subarray/range segment，只有命中后才重建相关祖先，降低内存占用。
 */
(() => {
  const TARGET = 49399797;
  const MAX_SEARCH_DEPTH = 8;

  const CORE = [
    'googleadservices.com/pagead/aclk',
    'www.youtube.com/pagead/adview',
    'www.youtube.com/pagead/interaction',
    'www.youtube.com/aboutthisad'
  ];

  const TINY_LAYOUT = 'video_display_button_group_layout.eml-fe';
  const PROMINENCE = 'home_vertical_feed_prominence_group_key';
  const DIVIDER = 'cell_divider.eml-fe';
  const NORMAL_THUMB = 'i.ytimg.com/vi/';

  function ascii(s) {
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
    return out;
  }

  const coreBytes = CORE.map(ascii);
  const tinyLayoutBytes = ascii(TINY_LAYOUT);
  const prominenceBytes = ascii(PROMINENCE);
  const dividerBytes = ascii(DIVIDER);
  const normalThumbBytes = ascii(NORMAL_THUMB);

  function readVarint(a, i, end) {
    let v = 0;
    let shift = 0;
    while (i < end && shift < 56) {
      const c = a[i++];
      v += (c & 0x7f) * Math.pow(2, shift);
      if (c < 0x80) return [v, i];
      shift += 7;
    }
    throw new Error('bad varint');
  }

  function varintBytes(v) {
    const arr = [];
    while (v >= 0x80) {
      arr.push((v % 128) | 0x80);
      v = Math.floor(v / 128);
    }
    arr.push(v);
    return new Uint8Array(arr);
  }

  function containsRange(a, start, end, needle) {
    if (end - start < needle.length) return false;
    outer:
    for (let i = start; i <= end - needle.length; i++) {
      for (let j = 0; j < needle.length; j++) {
        if (a[i + j] !== needle[j]) continue outer;
      }
      return true;
    }
    return false;
  }

  function coreHits(a, start, end) {
    let n = 0;
    for (let i = 0; i < coreBytes.length; i++) {
      if (containsRange(a, start, end, coreBytes[i])) n++;
    }
    return n;
  }

  function parseFields(a, start, end) {
    const fields = [];
    let i = start;
    try {
      while (i < end) {
        const fieldStart = i;
        const kv = readVarint(a, i, end);
        const key = kv[0];
        const keyEnd = kv[1];
        const fieldNo = Math.floor(key / 8);
        const wt = key & 7;
        if (!fieldNo || (wt !== 0 && wt !== 1 && wt !== 2 && wt !== 5)) return null;

        let payloadStart = keyEnd;
        let payloadEnd;
        let fieldEnd;
        if (wt === 0) {
          const vv = readVarint(a, keyEnd, end);
          payloadEnd = vv[1];
          fieldEnd = vv[1];
        } else if (wt === 1) {
          payloadEnd = keyEnd + 8;
          fieldEnd = payloadEnd;
        } else if (wt === 5) {
          payloadEnd = keyEnd + 4;
          fieldEnd = payloadEnd;
        } else {
          const lv = readVarint(a, keyEnd, end);
          payloadStart = lv[1];
          payloadEnd = payloadStart + lv[0];
          fieldEnd = payloadEnd;
        }
        if (fieldEnd > end) return null;
        fields.push({ no: fieldNo, wt, start: fieldStart, keyEnd, ps: payloadStart, pe: payloadEnd, end: fieldEnd });
        i = fieldEnd;
      }
      return i === end ? fields : null;
    } catch (_) {
      return null;
    }
  }

  function rangeSeg(s, e) { return { s, e }; }
  function bytesSeg(b) { return { b }; }
  function segLen(x) { return x.b ? x.b.length : x.e - x.s; }
  function totalLen(segs) {
    let n = 0;
    for (let i = 0; i < segs.length; i++) n += segLen(segs[i]);
    return n;
  }

  function emit(a, segs, len) {
    const out = new Uint8Array(len);
    let p = 0;
    for (let i = 0; i < segs.length; i++) {
      const x = segs[i];
      if (x.b) {
        out.set(x.b, p);
        p += x.b.length;
      } else {
        const v = a.subarray(x.s, x.e);
        out.set(v, p);
        p += v.length;
      }
    }
    return out;
  }

  function isShell(a, x) {
    const size = x.pe - x.ps;
    if (x.no !== 1 || size > 8192) return false;
    if (containsRange(a, x.ps, x.pe, normalThumbBytes)) return false;
    return containsRange(a, x.ps, x.pe, tinyLayoutBytes) &&
           containsRange(a, x.ps, x.pe, prominenceBytes);
  }

  function rewriteFeedContainer(a, start, end) {
    const f = parseFields(a, start, end);
    if (!f) return null;

    const drop = {};
    let ads = 0;
    let shells = 0;
    let dividers = 0;

    for (let i = 0; i < f.length; i++) {
      const x = f[i];
      if (x.wt !== 2) continue;

      if (x.no === 1 || x.no === 32) {
        const hits = coreHits(a, x.ps, x.pe);
        if (hits >= 2) {
          drop[i] = true;
          ads++;
          console.log(`[YT HomeFeed AdBlock v8] DROP AD field=${x.no} bytes=${x.pe - x.ps} hits=${hits}`);
          continue;
        }
      }

      if (isShell(a, x)) {
        drop[i] = true;
        shells++;
        console.log(`[YT HomeFeed AdBlock v8] DROP SHELL bytes=${x.pe - x.ps}`);
      }
    }

    // 删除被移除 item 后面的 divider；保留前一个 divider，确保相邻正常视频仍有分隔。
    for (let i = 0; i < f.length; i++) {
      if (drop[i]) continue;
      const x = f[i];
      if (x.wt !== 2 || x.no !== 1 || (x.pe - x.ps) > 3000) continue;
      if (!containsRange(a, x.ps, x.pe, dividerBytes)) continue;
      if (drop[i - 1]) {
        drop[i] = true;
        dividers++;
        console.log(`[YT HomeFeed AdBlock v8] DROP DIVIDER bytes=${x.pe - x.ps}`);
      }
    }

    if (ads === 0 && shells === 0) {
      return { changed: false, segs: [rangeSeg(start, end)], len: end - start, ads: 0, shells: 0, dividers: 0 };
    }

    const segs = [];
    for (let i = 0; i < f.length; i++) {
      if (!drop[i]) segs.push(rangeSeg(f[i].start, f[i].end));
    }
    return { changed: true, segs, len: totalLen(segs), ads, shells, dividers };
  }

  // 在任意前 8 层 message 中寻找 field #49399797；命中后只重建该分支。
  function rewriteSearch(a, start, end, depth) {
    const f = parseFields(a, start, end);
    if (!f) return null;

    let changed = false;
    let ads = 0;
    let shells = 0;
    let dividers = 0;
    const segs = [];

    for (let i = 0; i < f.length; i++) {
      const x = f[i];
      let child = null;

      if (x.wt === 2 && x.no === TARGET) {
        child = rewriteFeedContainer(a, x.ps, x.pe);
      } else if (x.wt === 2 && depth < MAX_SEARCH_DEPTH) {
        const probe = parseFields(a, x.ps, x.pe);
        if (probe) child = rewriteSearch(a, x.ps, x.pe, depth + 1);
      }

      if (child && child.changed) {
        segs.push(rangeSeg(x.start, x.keyEnd));
        segs.push(bytesSeg(varintBytes(child.len)));
        for (let j = 0; j < child.segs.length; j++) segs.push(child.segs[j]);
        changed = true;
        ads += child.ads;
        shells += child.shells;
        dividers += child.dividers;
      } else {
        segs.push(rangeSeg(x.start, x.end));
      }
    }

    return { changed, segs, len: totalLen(segs), ads, shells, dividers };
  }

  try {
    const input = $response.body instanceof Uint8Array ? $response.body : new Uint8Array($response.body);
    console.log(`[YT HomeFeed AdBlock v8] START bytes=${input.length}`);

    const plan = rewriteSearch(input, 0, input.length, 0);
    if (plan && plan.changed) {
      const out = emit(input, plan.segs, plan.len);
      console.log(`[YT HomeFeed AdBlock v8] DONE ads=${plan.ads} shells=${plan.shells} dividers=${plan.dividers}, ${input.length} -> ${out.length}`);
      $done({ body: out });
    } else {
      console.log(`[YT HomeFeed AdBlock v8] PASS bytes=${input.length}`);
      $done({});
    }
  } catch (e) {
    console.log(`[YT HomeFeed AdBlock v8] ERROR ${e}`);
    $done({});
  }
})();
