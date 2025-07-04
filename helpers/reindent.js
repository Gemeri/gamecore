const dedent = str => {
  const lines = str.replace(/\r\n/g, '\n').split('\n');
  const indentLens = lines
    .filter(l => l.trim())
    .map(l => l.match(/^\s*/)[0].length);
  const minIndent = Math.min(...indentLens, 0);
  return lines.map(l => l.slice(minIndent)).join('\n');
};

function reindentSnippet(snippet, anchorIndent) {
  const indentStr = anchorIndent;
  const rawLines  = dedent(snippet).split('\n');
  return rawLines
    .map(l => (l.trim() ? indentStr + l : l))
    .join('\n');
}

module.exports = { reindentSnippet, dedent };
