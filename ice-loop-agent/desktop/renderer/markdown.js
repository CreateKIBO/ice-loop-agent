(function (root) {
  'use strict';
  const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  function inline(text) {
    return escapeHTML(text).replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  }
  function renderMarkdown(markdown, figures = {}) {
    const output = [];
    let code = null;
    let lines = [];
    let paragraph = [];
    const flush = () => { if (paragraph.length) { output.push('<p>' + inline(paragraph.join(' ')) + '</p>'); paragraph = []; } };
    for (const line of String(markdown || '').split('\n')) {
      if (/^\s*```/.test(line)) {
        flush();
        if (code !== null) { output.push('<pre><code>' + escapeHTML(lines.join('\n')) + '</code></pre>'); code = null; lines = []; }
        else code = line.trim().slice(3);
        continue;
      }
      if (code !== null) { lines.push(line); continue; }
      if (/^\s*<!--.*-->\s*$/.test(line)) continue;
      const heading = line.match(/^(#{1,4})\s+(.+)$/);
      const figure = line.match(/^!\[([^\]]*)\]\(([^)]*)\)$/);
      if (heading) { flush(); const level = heading[1].length; output.push(`<h${level}>${inline(heading[2])}</h${level}>`); }
      else if (figure) {
        flush();
        const no = figure[1].match(/图(\d+)/)?.[1];
        const url = figures[no];
        if (url && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(url)) output.push('<figure><img class="article-image" src="' + url + '" alt="' + escapeHTML(figure[1]) + '"><figcaption>' + escapeHTML(figure[1]) + '</figcaption></figure>');
        else output.push('<div class="figure-placeholder">▧ &nbsp;' + escapeHTML(figure[1]) + '<br>配图位置 · 待导入图片</div>');
      } else if (/^>/.test(line)) { flush(); output.push('<blockquote>' + inline(line.replace(/^>\s?/, '')) + '</blockquote>'); }
      else if (/^[-*]\s/.test(line)) { flush(); output.push('<p class="list-line">• ' + inline(line.slice(2)) + '</p>'); }
      else if (!line.trim()) flush();
      else paragraph.push(line);
    }
    if (code !== null) output.push('<pre><code>' + escapeHTML(lines.join('\n')) + '</code></pre>');
    flush();
    return output.join('\n');
  }
  root.iceMarkdown = { escapeHTML, renderMarkdown };
  if (typeof module !== 'undefined') module.exports = root.iceMarkdown;
})(typeof window !== 'undefined' ? window : globalThis);
