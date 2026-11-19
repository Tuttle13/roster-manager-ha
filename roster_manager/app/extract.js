// Runs inside the Sabre page (page.evaluate). Returns the same "prm-capture" payload as the
// Safari bookmark: visible text, tables, and a cleaned copy of the page structure.
// Form field values, scripts, images and URL query strings are never included.
() => {
  var KEEP = { 'class': 1, id: 1, colspan: 1, rowspan: 1, title: 1, headers: 1, scope: 1, role: 1, 'aria-label': 1, href: 1 };
  var DROP = 'script,style,noscript,svg,canvas,iframe,frame,object,embed,input,select,textarea,link,meta,img,video,audio,template';
  function cleanHtml(d) {
    var c = d.body.cloneNode(true);
    var rm = c.querySelectorAll(DROP); for (var i = 0; i < rm.length; i++) rm[i].remove();
    var all = c.querySelectorAll('*');
    for (var j = 0; j < all.length; j++) {
      var el = all[j];
      for (var k = el.attributes.length - 1; k >= 0; k--) {
        var n = el.attributes[k].name;
        if (n === 'href') { var h = el.getAttribute('href') || ''; el.setAttribute('href', h.split('?')[0].split('#')[0]); continue; }
        if (!KEEP[n] && n.indexOf('data-') !== 0) el.removeAttribute(n);
      }
    }
    var h2 = c.innerHTML.replace(/\s{2,}/g, ' ');
    return h2.length > 1500000 ? h2.slice(0, 1500000) + '<!-- truncated -->' : h2;
  }
  function tables(d) {
    return [].map.call(d.querySelectorAll('table'), function (t) {
      return {
        id: t.id || '', cls: t.className || '',
        rows: [].map.call(t.rows, function (r) {
          return [].map.call(r.cells, function (c) {
            var o = { t: (c.innerText || c.textContent || '').trim() };
            if (c.colSpan > 1) o.cs = c.colSpan; if (c.rowSpan > 1) o.rs = c.rowSpan; if (c.tagName === 'TH') o.h = 1;
            var tt = c.getAttribute('title'); if (tt) o.title = tt;
            return o;
          });
        })
      };
    }).filter(function (t) { return t.rows.length; });
  }
  var docs = [document];
  (function walk(d) { var fr = d.querySelectorAll('iframe,frame'); for (var i = 0; i < fr.length; i++) { try { var cd = fr[i].contentDocument; if (cd && cd.body) { docs.push(cd); walk(cd); } } catch (e) { } } })(document);
  var frames = docs.map(function (d) {
    var l = d.location || {};
    return { host: l.hostname || '', path: l.pathname || '', title: d.title || '', text: (d.body.innerText || '').slice(0, 500000), tables: tables(d), html: cleanHtml(d) };
  }).filter(function (f) { return f.text.trim() || f.tables.length; });
  var links = [];
  docs.forEach(function (d) {
    [].forEach.call(d.querySelectorAll('a[href], [onclick], button'), function (a) {
      var t = (a.innerText || a.textContent || a.getAttribute('title') || '').trim().slice(0, 80);
      if (!t) return;
      var href = (a.getAttribute('href') || '').split('?')[0];
      links.push({ text: t, href: href, tag: a.tagName.toLowerCase(), id: a.id || '' });
    });
  });
  return {
    format: 'prm-capture', v: 1, capturedAt: new Date().toISOString(), source: 'ha-app',
    tzOffsetMin: -new Date().getTimezoneOffset(), url: location.origin + location.pathname, title: document.title,
    frames: frames, links: links.slice(0, 400)
  };
}
