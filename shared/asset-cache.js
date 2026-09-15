/* 静态资源缓存（Cache API）公共实现：midi_player 与 music_visualization 共用。
   版本化缓存名；绝对路径为键；ignoreSearch 提高命中率；fetchFresh 供需要最新数据的清单使用。 */
(function(g){
  'use strict';
  function createAssetCache(name){
    if(!name) throw new Error('cache name required');
    return {
      cacheName: name,
      _abs(url){ return new URL(url, g.location.href).href; },
      async fetch(url){
        const absUrl = this._abs(url);
        try{
          const cache = await caches.open(this.cacheName);
          const cached = await cache.match(absUrl, {ignoreSearch: true});
          if(cached) return cached.clone();
          const resp = await fetch(url);
          if(resp.ok) cache.put(absUrl, resp.clone());
          return resp;
        }catch(e){
          return fetch(url);
        }
      },
      async has(url){
        try{
          const cache = await caches.open(this.cacheName);
          const cached = await cache.match(this._abs(url), {ignoreSearch: true});
          return !!cached;
        }catch(e){ return false; }
      },
      async fetchFresh(url){
        const absUrl = this._abs(url);
        const resp = await fetch(url, {cache: 'no-store'});
        try{
          const cache = await caches.open(this.cacheName);
          if(resp.ok) cache.put(absUrl, resp.clone());
        }catch(e){}
        return resp;
      }
    };
  }
  g.createAssetCache = createAssetCache;
})(typeof window !== 'undefined' ? window : this);
