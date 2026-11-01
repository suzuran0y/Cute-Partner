(() => {
  'use strict';
  // Construct DOM directly: model HTML is always text, never parsed as HTML.
  function inline(parent, text) {
    const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g; let at = 0;
    for (const m of text.matchAll(pattern)) {
      parent.append(document.createTextNode(text.slice(at, m.index))); const part = m[0]; let node;
      if (part.startsWith('`')) { node = document.createElement('code'); node.textContent = part.slice(1, -1); }
      else if (part.startsWith('**')) { node = document.createElement('strong'); node.textContent = part.slice(2, -2); }
      else { const link = /^\[([^\]]+)\]\((.+)\)$/.exec(part); node = document.createElement('a'); node.textContent = link[1]; node.href = link[2]; node.title = link[2]; node.onclick = event => { event.preventDefault(); void window.desktop.openLink(link[2]); }; }
      parent.append(node); at = m.index + part.length;
    }
    parent.append(document.createTextNode(text.slice(at)));
  }
  function render(text) {
    const root = document.createElement('div'), lines = text.split('\n'); root.className = 'markdown'; let i = 0;
    const cells = line => line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
    while (i < lines.length) {
      const line = lines[i];
      if (/^\s*```/.test(line)) {
        const lang = line.replace(/^\s*```/, '').trim(); i++; const chunks = []; while (i < lines.length && !/^\s*```/.test(lines[i])) chunks.push(lines[i++]); if (i < lines.length) i++;
        const block = document.createElement('div'), top = document.createElement('div'), label = document.createElement('span'), copy = document.createElement('button'), pre = document.createElement('pre'), code = document.createElement('code');
        block.className = 'code-block'; top.className = 'code-top'; label.textContent = lang || '代码'; copy.type = 'button'; copy.textContent = '复制代码'; code.textContent = chunks.join('\n'); copy.onclick = () => window.desktop.copyText(code.textContent); top.append(label, copy); pre.append(code); block.append(top, pre); root.append(block); continue;
      }
      if (line.includes('|') && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] || '')) {
        const table = document.createElement('table'), header = document.createElement('tr'); for (const c of cells(line)) { const th = document.createElement('th'); inline(th, c); header.append(th); } table.append(header); i += 2;
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) { const tr = document.createElement('tr'); for (const c of cells(lines[i++])) { const td = document.createElement('td'); inline(td, c); tr.append(td); } table.append(tr); }
        const wrap = document.createElement('div'); wrap.className = 'table-wrap'; wrap.append(table); root.append(wrap); continue;
      }
      const heading = /^(#{1,6})\s+(.+)$/.exec(line), list = /^\s*([-*+]|\d+\.) (.+)$/.exec(line), quote = /^>\s?(.*)$/.exec(line);
      if (heading) { const node = document.createElement('h' + heading[1].length); inline(node, heading[2]); root.append(node); }
      else if (list) { const node = document.createElement('p'); node.className = 'list-line'; inline(node, (/\d/.test(list[1]) ? list[1] : '•') + ' ' + list[2]); root.append(node); }
      else if (quote) { const node = document.createElement('blockquote'); inline(node, quote[1]); root.append(node); }
      else if (line.trim()) { const node = document.createElement('p'); inline(node, line); root.append(node); }
      i++;
    }
    return root;
  }
  window.safeMarkdown = { render };
})();
