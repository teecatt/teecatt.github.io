/* 访客相关纯函数（门户 / GPU 增强页 / 访客地图共用）：
   调色板、天气图标、HTML 转义、国旗 emoji、行键、球面角距。
   带状态的 i18n（语言、城市列表）与选择逻辑仍留在各页面，避免共享模块依赖页面全局。 */
(function(g){
  'use strict';
  var COLORS = ['#58a6ff','#3fb950','#e8b64c','#ff7b72','#c822ff','#2dd4bf','#ff9e64','#a5d6ff','#f778ba','#7ee787'];
  var W_ICON = {0:'☀️',1:'🌤️',2:'⛅',3:'☁️',45:'🌫️',48:'🌫️',51:'🌦️',53:'🌧️',55:'🌧️',61:'🌧️',63:'🌧️',65:'🌧️',71:'🌨️',73:'🌨️',75:'🌨️',80:'🌦️',81:'🌧️',82:'🌧️',95:'⛈️',96:'⛈️',99:'⛈️'};
  function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
  function colorFor(s){ s=String(s||'?'); var h=0; for(var i=0;i<s.length;i++) h=(h*31+s.charCodeAt(i))>>>0; return COLORS[h%COLORS.length]; }
  function flag(code){ if(!code||String(code).length!==2) return ''; return String.fromCodePoint.apply(null, String(code).toUpperCase().split('').map(function(ch){ return 0x1F1E6+ch.charCodeAt(0)-65; })); }
  function rowKey(o){ return [o.country||'',o.region||'',o.city||''].join('|'); }
  function angularDist(a,b,c,d){ var R=Math.PI/180; var dLat=(c-a)*R,dLon=(d-b)*R; var s=Math.sin(dLat/2)*Math.sin(dLat/2)+Math.cos(a*R)*Math.cos(c*R)*Math.sin(dLon/2)*Math.sin(dLon/2); return 2*Math.asin(Math.min(1,Math.sqrt(s)))/R; }
  g.Visitor = { COLORS: COLORS, W_ICON: W_ICON, esc: esc, colorFor: colorFor, flag: flag, rowKey: rowKey, angularDist: angularDist };
})(typeof window !== 'undefined' ? window : this);
