'use strict';

// CMS emits XML plists containing dates and certificate data, which plutil's JSON
// format cannot represent on every Xcode version. Parse only Apple's plist types;
// never resolve a DTD, external entity, or executable input.
function parseXmlPlist(xml) {
  if (typeof xml !== 'string' || /<!ENTITY/i.test(xml)) throw new Error('Unsupported provisioning plist');
  const source = xml.replace(/<\?[\s\S]*?\?>/g, '').replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!DOCTYPE[^>]*>/g, '').trim();
  const tokens = source.match(/<[^>]*>|[^<]+/g) || [];
  let index = 0;
  const skipSpace = () => { while (index < tokens.length && /^\s*$/.test(tokens[index])) index += 1; };
  const take = () => { skipSpace(); return tokens[index++]; };
  const decode = (value) => value.replace(/&([^;]+);/g, (_match, entity) => {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (Object.hasOwn(named, entity)) return named[entity];
    if (/^#x[\da-f]+$/i.test(entity)) return String.fromCodePoint(parseInt(entity.slice(2), 16));
    if (/^#\d+$/.test(entity)) return String.fromCodePoint(Number(entity.slice(1)));
    throw new Error('Unsupported plist entity');
  });
  function value() {
    const opening = take();
    const match = /^<(dict|array|string|key|date|data|integer|real|true|false)\s*(\/?)>$/.exec(opening || '');
    if (!match) throw new Error('Malformed provisioning plist');
    const [, type, empty] = match;
    if (type === 'true' || type === 'false') {
      if (!empty && take() !== `</${type}>`) throw new Error('Malformed plist boolean');
      return type === 'true';
    }
    if (type === 'array' || type === 'dict') {
      const result = type === 'array' ? [] : Object.create(null);
      if (empty) return result;
      while (true) {
        skipSpace();
        if (tokens[index] === `</${type}>`) { index += 1; return result; }
        if (type === 'array') result.push(value());
        else {
          if (!/^<key(?:\s*\/?)>$/.test(tokens[index] || '')) throw new Error('Missing plist dictionary key');
          const key = value();
          if (Object.hasOwn(result, key)) throw new Error('Duplicate plist dictionary key');
          result[key] = value();
        }
      }
    }
    let text = '';
    if (!empty) {
      while (index < tokens.length && !tokens[index].startsWith('<')) text += tokens[index++];
      if (tokens[index++] !== `</${type}>`) throw new Error('Malformed plist scalar');
    }
    text = decode(text);
    if (type === 'data') return text.replace(/\s/g, '');
    if (type === 'integer' || type === 'real') {
      if (!text.trim() || !Number.isFinite(Number(text))) throw new Error('Invalid plist number');
      return Number(text);
    }
    return text;
  }
  if (!/^<plist\s+version=["']1\.0["']\s*>$/.test(take() || '')) throw new Error('Missing plist document');
  const result = value();
  if (take() !== '</plist>' || take() !== undefined) throw new Error('Malformed plist document');
  return result;
}

module.exports = { parseXmlPlist };
