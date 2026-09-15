/* 构建信息展示（按区域）：读取 window.AREA_BUILD[区域] 或 SITE_BUILD/CRYPTO_BUILD/NOTES_BUILD。
   区域时间线 = 该页面目录 + 其用到的共享组件文件的最后一次提交，因此 shared/ 变更会同时抬高所有使用方的“最近构建”。
   用法：<span data-build="midi"></span>，脚本自动初始化并每 30s 刷新相对时间。 */
(function(g){
  'use strict';
  function ago(ms){
    var s = Math.max(0, Math.floor(ms / 1000));
    if(s < 60) return '刚刚';
    var m = Math.floor(s / 60); if(m < 60) return m + ' 分钟前';
    var h = Math.floor(m / 60); if(h < 24) return h + ' 小时前';
    var d = Math.floor(h / 24); if(d < 30) return d + ' 天前';
    var mo = Math.floor(d / 30); if(mo < 12) return mo + ' 个月前';
    return Math.floor(mo / 12) + ' 年前';
  }
  function infoFor(key){
    if(key === 'site') return g.SITE_BUILD;
    if(key === 'crypto') return g.CRYPTO_BUILD;
    if(key === 'notes') return g.NOTES_BUILD;
    return (g.AREA_BUILD || {})[key];
  }
  function render(el, info){
    if(!el) return;
    if(!info || !info.sha){ el.textContent = '最近构建：未知'; return; }
    el.textContent = '';
    var a = document.createElement('a');
    a.href = 'https://github.com/23776301/23776301.github.io/commit/' + info.sha;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = '最近构建：' + ago(Date.now() - (info.time || 0)) + ' · ' + String(info.sha).substring(0, 7);
    a.style.color = 'inherit';
    a.style.textDecoration = 'underline';
    a.style.textUnderlineOffset = '2px';
    el.appendChild(a);
  }
  function init(root){
    var nodes = (root || document).querySelectorAll('[data-build]');
    Array.prototype.forEach.call(nodes, function(el){
      render(el, infoFor(el.getAttribute('data-build')));
    });
  }
  g.BuildStamp = { init: init, render: render, ago: ago };
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function(){ init(); });
  else init();
  setInterval(function(){ init(); }, 30000);
})(window);
