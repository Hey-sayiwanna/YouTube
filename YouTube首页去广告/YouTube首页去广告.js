/*
 * YouTube iOS 首页 Feed Sponsored 广告补丁 v7
 *
 * v7 修复两件事：
 * 1) v6 在 2 MB 级 /browse 上递归 slice/重建整个 protobuf，Surge JSC 会出现内存警告。
 *    v7 不再全树递归，只解析 Home Feed 必经的三层：
 *      top-level field #10 -> field #49399797 -> 直接 Feed item
 * 2) v5/v6 删除广告内部 payload 后，可能残留一个小型 EML 外壳，表现为首页灰/黑空框。
 *    v7 会删除完整广告 item，同时清理已知的残留空壳及相邻 divider。
 *
 * 所有检测都直接在原 Uint8Array 的区间上扫描，避免 TextEncoder 和大规模切片。
 */
(() => {
  const CORE = [
    'googleadservices.com/pagead/aclk',
    'www.youtube.com/pagead/adview',
    'www.youtube.com/pagead/interaction',
    'www.youtube.com/aboutthisad'
  ];

  const SHELL = [
    'www.youtube.com/pcs/activeview',
    'dynamic_reels_image_ad_tooltip_state',
    'full_width_square_image_layout.eml-fe'
  ];

  const TINY_LAYOUT = 'video_display_button_group_layout.eml-fe';
  const DIVIDER = 'cell_divider.eml-fe';
  const NORMAL_THUMB = 'i.ytimg.com/vi/';

  function ascii(s) {
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
    return out;
  }

  const coreBytes = CORE.map(ascii);
  const shellBytes = SHELL.map(ascii);
  const tinyLayoutBytes = ascii(TINY_LAYOUT);
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

  function anyShell(a, start, end) {
    for (let i = 0; i < shellBytes.length; i++) {
      if (containsRange(a, start, end, shellBytes[i])) return true;
    }
    return false;
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

        fields.push({
          no: fieldNo,
          wt: wt,
          start: fieldStart,
          keyEnd: keyEnd,
          ps: payloadStart,
          pe: payloadEnd,
          end: fieldEnd
        });

        i = fieldEnd;
      }

      return i === end ? fields : null;
    } catch (_) {
      return null;
    }
  }

  function rangeSeg(s, e) { return { s: s, e: e }; }
  function bytesSeg(b) { return { b: b }; }

  function segLen(seg) {
    return seg.b ? seg.b.length : (seg.e - seg.s);
  }

  function totalLen(segs) {
    let n = 0;
    for (let i = 0; i < segs.length; i++) n += segLen(segs[i]);
    return n;
  }

  function emit(a, segs, len) {
    const out = new Uint8Array(len);
    let p = 0;
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      if (seg.b) {
        out.set(seg.b, p);
        p += seg.b.length;
      } else {
        const view = a.subarray(seg.s, seg.e);
        out.set(view, p);
        p += view.length;
      }
    }
    return out;
  }

  function planGroup(a, start, end) {
    const f = parseFields(a, start, end);
    if (!f) return null;

    const drop = {};
    let ads = 0;
    let shells = 0;

    for (let i = 0; i < f.length; i++) {
      const x = f[i];
      if (x.wt !== 2 || (x.no !== 1 && x.no !== 32)) continue;

      const size = x.pe - x.ps;
      const hits = coreHits(a, x.ps, x.pe);

      if (hits >= 2) {
        drop[i] = true;
        ads++;
        console.log(`[YT HomeFeed AdBlock v7] DROP AD field=${x.no} bytes=${size} hits=${hits}`);
        continue;
      }

      if (x.no === 1 && size <= 8192) {
        let isShell = anyShell(a, x.ps, x.pe);

        if (!isShell && size <= 2048 &&
            containsRange(a, x.ps, x.pe, tinyLayoutBytes) &&
            !containsRange(a, x.ps, x.pe, normalThumbBytes)) {
          isShell = true;
        }

        if (isShell) {
          drop[i] = true;
          shells++;
          console.log(`[YT HomeFeed AdBlock v7] DROP SHELL bytes=${size}`);
        }
      }
    }

    for (let i = 0; i < f.length; i++) {
      if (drop[i]) continue;
      const x = f[i];

      if (x.wt === 2 && x.no === 1 && (x.pe - x.ps) <= 3000 &&
          containsRange(a, x.ps, x.pe, dividerBytes) &&
          (drop[i - 1] || drop[i + 1])) {
        drop[i] = true;
        console.log(`[YT HomeFeed AdBlock v7] DROP DIVIDER bytes=${x.pe - x.ps}`);
      }
    }

    if (ads === 0 && shells === 0) {
      return { changed: false, segs: [rangeSeg(start, end)], len: end - start, ads: 0, shells: 0 };
    }

    const segs = [];
    for (let i = 0; i < f.length; i++) {
      if (!drop[i]) segs.push(rangeSeg(f[i].start, f[i].end));
    }

    return {
      changed: true,
      segs: segs,
      len: totalLen(segs),
      ads: ads,
      shells: shells
    };
  }

  function planField10(a, start, end) {
    const f = parseFields(a, start, end);
    if (!f) return null;

    const segs = [];
    let changed = false;
    let ads = 0;
    let shells = 0;

    for (let i = 0; i < f.length; i++) {
      const x = f[i];

      if (x.wt === 2 && x.no === 49399797) {
        const gp = planGroup(a, x.ps, x.pe);
        if (gp && gp.changed) {
          segs.push(rangeSeg(x.start, x.keyEnd));
          segs.push(bytesSeg(varintBytes(gp.len)));
          for (let j = 0; j < gp.segs.length; j++) segs.push(gp.segs[j]);
          changed = true;
          ads += gp.ads;
          shells += gp.shells;
          continue;
        }
      }

      segs.push(rangeSeg(x.start, x.end));
    }

    return {
      changed: changed,
      segs: segs,
      len: totalLen(segs),
      ads: ads,
      shells: shells
    };
  }

  function planTop(a) {
    const f = parseFields(a, 0, a.length);
    if (!f) return null;

    const segs = [];
    let changed = false;
    let ads = 0;
    let shells = 0;

    for (let i = 0; i < f.length; i++) {
      const x = f[i];

      if (x.wt === 2 && x.no === 10) {
        const hp = planField10(a, x.ps, x.pe);
        if (hp && hp.changed) {
          segs.push(rangeSeg(x.start, x.keyEnd));
          segs.push(bytesSeg(varintBytes(hp.len)));
          for (let j = 0; j < hp.segs.length; j++) segs.push(hp.segs[j]);
          changed = true;
          ads += hp.ads;
          shells += hp.shells;
          continue;
        }
      }

      segs.push(rangeSeg(x.start, x.end));
    }

    return {
      changed: changed,
      segs: segs,
      len: totalLen(segs),
      ads: ads,
      shells: shells
    };
  }

  try {
    const input = $response.body instanceof Uint8Array
      ? $response.body
      : new Uint8Array($response.body);

    console.log(`[YT HomeFeed AdBlock v7] START bytes=${input.length}`);

    const plan = planTop(input);

    if (plan && plan.changed) {
      const out = emit(input, plan.segs, plan.len);
      console.log(`[YT HomeFeed AdBlock v7] DONE ads=${plan.ads} shells=${plan.shells}, ${input.length} -> ${out.length}`);
      $done({ body: out });
    } else {
      console.log(`[YT HomeFeed AdBlock v7] PASS bytes=${input.length}`);
      $done({});
    }
  } catch (e) {
    console.log(`[YT HomeFeed AdBlock v7] ERROR ${e}`);
    $done({});
  }
})();
