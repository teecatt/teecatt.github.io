// 共享标签防碰撞：
//  - 屏幕坐标用 globe.getScreenCoords()（不逐帧读 DOM 布局，性能好）
//  - 每个标签的尺寸与“内容中心相对锚点的偏移”只在首次测量后缓存，内容变化才重测
//  - 按优先级贪心放置：选中 > 我 > 访问量；用网格加速，严格重叠者隐藏
// 用法：LabelCollide.fit(globe, items, { altitude, pad, cell, hideClass, expand })
//   items: [{ el, lat, lon, pri, sizeKey }]
(function () {
  function setCls(el, cls, on) {
    var has = el.classList.contains(cls);
    if (on) { if (!has) el.classList.add(cls); }
    else if (has) el.classList.remove(cls);
  }

  function fit(globe, items, opts) {
    if (!globe || !items) return;
    opts = opts || {};
    var alt = opts.altitude == null ? 0.06 : opts.altitude;
    var pad = opts.pad == null ? 0 : opts.pad;
    var ovl = opts.overlap == null ? 0.2 : opts.overlap; // 允许的重叠比例（相对较小者面积），超过才隐藏
    var cell = opts.cell || 40;
    var hide = opts.hideClass || 'gl-hide';
    var expand = opts.expand || 0; // 选中项额外占位，保证周围不被压

    var cand = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i], el = it.el;
      if (!el) continue;
      if (el.style.display === 'none') { setCls(el, hide, true); continue; }
      var p = null;
      try { p = globe.getScreenCoords(it.lat, it.lon, alt); } catch (e) { p = null; }
      if (!p || !isFinite(p.x) || !isFinite(p.y)) { setCls(el, hide, true); continue; }

      var m = el.__lc;
      if (!m || m.k !== it.sizeKey) {
        var box = el.firstElementChild || el, r = box.getBoundingClientRect();
        m = el.__lc = (r.width < 1 || r.height < 1)
          ? { k: it.sizeKey, w: 0, h: 0, dx: 0, dy: 0 }
          : { k: it.sizeKey, w: r.width, h: r.height,
              dx: (r.left + r.width / 2) - p.x, dy: (r.top + r.height / 2) - p.y };
      }
      if (m.w < 1 || m.h < 1) { setCls(el, hide, true); continue; }

      var ex = it.pri >= 1e9 ? expand : 0;
      var cx = p.x + m.dx, cy = p.y + m.dy;
      cand.push({ el: el, pri: it.pri || 0,
        x0: cx - m.w / 2 - ex, x1: cx + m.w / 2 + ex,
        y0: cy - m.h / 2 - ex, y1: cy + m.h / 2 + ex });
    }

    cand.sort(function (a, b) { return b.pri - a.pri; });

    var grid = {};
    for (var n = 0; n < cand.length; n++) {
      var c = cand[n], x0 = c.x0, x1 = c.x1, y0 = c.y0, y1 = c.y1;
      var gx, gy, b, k, o;
      var area = (x1 - x0) * (y1 - y0);
      var gx0 = Math.floor((x0 - pad) / cell), gx1 = Math.floor((x1 + pad) / cell);
      var gy0 = Math.floor((y0 - pad) / cell), gy1 = Math.floor((y1 + pad) / cell);
      // 与已放置标签的最大重叠比例（交集 / 较小者面积）；只有超过阈值才算冲突
      var worst = 0;
      for (gx = gx0; gx <= gx1 && worst <= ovl; gx++) {
        for (gy = gy0; gy <= gy1 && worst <= ovl; gy++) {
          b = grid[gx + ',' + gy]; if (!b) continue;
          for (k = 0; k < b.length; k++) {
            o = b[k];
            var ix = Math.min(x1, o.x1) - Math.max(x0, o.x0);
            var iy = Math.min(y1, o.y1) - Math.max(y0, o.y0);
            if (ix <= 0 || iy <= 0) continue;
            var denom = Math.min(area, o.a);
            if (denom > 0) { var r = (ix * iy) / denom; if (r > worst) worst = r; }
          }
        }
      }
      if (worst > ovl) { setCls(c.el, hide, true); }
      else {
        setCls(c.el, hide, false);
        for (gx = gx0; gx <= gx1; gx++) {
          for (gy = gy0; gy <= gy1; gy++) {
            var key = gx + ',' + gy;
            (grid[key] = grid[key] || []).push({ x0: x0, x1: x1, y0: y0, y1: y1, a: area });
          }
        }
      }
    }
  }

  window.LabelCollide = { fit: fit };
})();
